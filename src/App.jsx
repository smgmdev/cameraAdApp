import React, { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://jfawqflonbexcytcezkp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpmYXdxZmxvbmJleGN5dGNlemtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM2NTA5NTIsImV4cCI6MjA3OTIyNjk1Mn0.ATy3-ifKMrpi8159C1MlA-IvKRDKjZsZKPaI-M7REP0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// WebRTC globals (per-browser-tab). These are not shared between devices,
// signaling is done via Supabase Realtime channels per ad.
let localStream = null; // provider's camera stream
let providerPeerConnection = null;
let clientPeerConnection = null;

export default function App() {
  const [screen, setScreen] = useState("role-select");
  const [role, setRole] = useState(null);
  const [clientId, setClientId] = useState(null);
  const [providerId, setProviderId] = useState(null);
  const [ads, setAds] = useState([]);
  const [selectedAd, setSelectedAd] = useState(null);

  // Load ads initially
  useEffect(() => {
    async function loadAds() {
      const { data, error } = await supabase
        .from("ads")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Failed to load ads from Supabase", error);
        return;
      }

      setAds(data || []);
    }

    loadAds();
  }, []);

  // Supabase realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel("public:ads")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ads" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setAds((prev) => {
              const exists = prev.some((ad) => ad.id === payload.new.id);
              if (exists) {
                return prev.map((ad) =>
                  ad.id === payload.new.id ? payload.new : ad
                );
              }
              return [payload.new, ...prev];
            });
          } else if (payload.eventType === "UPDATE") {
            setAds((prev) =>
              prev.map((ad) => (ad.id === payload.new.id ? payload.new : ad))
            );
          } else if (payload.eventType === "DELETE") {
            setAds((prev) => prev.filter((ad) => ad.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Callbacks for login
  const handleClientLogin = (id) => {
    setClientId(id);
    setScreen("client-dashboard");
  };

  const handleProviderLogin = (id) => {
    setProviderId(id);
    setScreen("provider-dashboard");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex justify-center items-center px-4 py-6">
      <div className="w-full max-w-md bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl p-6">
        {screen === "role-select" && (
          <RoleSelect setScreen={setScreen} setRole={setRole} />
        )}

        {screen === "client-login" && (
          <ClientLogin setScreen={setScreen} onLogin={handleClientLogin} />
        )}

        {screen === "provider-login" && (
          <ProviderLogin setScreen={setScreen} onLogin={handleProviderLogin} />
        )}

        {screen === "client-dashboard" && (
          <ClientDashboard setScreen={setScreen} />
        )}

        {screen === "create-ad" && (
          <CreateAdView
            setScreen={setScreen}
            setAds={setAds}
            clientId={clientId}
          />
        )}

        {screen === "ad-manager" && (
          <AdManagerView
            ads={ads}
            clientId={clientId}
            setScreen={setScreen}
            setSelectedAd={setSelectedAd}
          />
        )}

        {screen === "provider-dashboard" && (
          <ProviderDashboard
            ads={ads}
            setScreen={setScreen}
            setSelectedAd={setSelectedAd}
          />
        )}

        {screen === "provider-job-details" && selectedAd && (
          <ProviderJobDetails
            ad={selectedAd}
            setScreen={setScreen}
            onAccept={async (ad) => {
              try {
                // Validate ad.id before hitting Supabase
                if (!ad || ad.id === undefined || ad.id === null) {
                  console.error(
                    "Supabase UPDATE error: invalid ad passed to onAccept",
                    ad
                  );
                  alert(
                    "Cannot accept this job because it has no valid ID in the database."
                  );
                  return;
                }

                // Try to get camera stream, but do NOT treat this as a Supabase error
                let stream = null;

                if (
                  typeof navigator !== "undefined" &&
                  navigator.mediaDevices?.getUserMedia &&
                  typeof window !== "undefined" &&
                  window.isSecureContext
                ) {
                  try {
                    stream = await navigator.mediaDevices.getUserMedia({
                      video: true,
                      audio: false,
                    });
                    localStream = stream;
                  } catch (camErr) {
                    console.warn("Camera error:", camErr);
                    alert(
                      "Camera is not available. You can still accept the job, but live video won't be shown."
                    );
                  }
                } else {
                  console.warn(
                    "Camera API not available or insecure context; continuing without live stream."
                  );
                }

                // Supabase status update with stronger error handling
                const { data, error } = await supabase
                  .from("ads")
                  .update({ status: "camera_ready" })
                  .eq("id", ad.id)
                  .select("*")
                  .single();

                if (error) {
                  console.error("Supabase UPDATE error:", error);
                  alert(
                    "Failed to update job status: " +
                      (error.message ?? "Unknown Supabase error")
                  );
                  return;
                }

                if (!data) {
                  console.error(
                    "Supabase UPDATE error: no row returned for id",
                    ad.id
                  );
                  alert(
                    "Failed to update job status: no matching job found in database."
                  );
                  return;
                }

                // Update local state with the fresh row from Supabase
                setAds((prev) =>
                  prev.map((item) => (item.id === data.id ? data : item))
                );

                setSelectedAd(data);
                setScreen("provider-live");
              } catch (err) {
                console.error("Provider accept job error:", err);
                alert(
                  "Unexpected error while accepting job: " +
                    (err?.message || "Unknown error")
                );
              }
            }}
          />
        )}

        {screen === "provider-live" && selectedAd && (
          <ProviderLiveView ad={selectedAd} setScreen={setScreen} />
        )}

        {screen === "client-live" && selectedAd && (
          <ClientLiveView ad={selectedAd} setScreen={setScreen} />
        )}
      </div>
    </div>
  );
}

/* ===== ROLE SELECT ===== */

function RoleSelect({ setScreen, setRole }) {
  return (
    <div className="flex flex-col gap-6 text-center">
      <h1 className="text-xl font-semibold">Welcome</h1>
      <p className="text-slate-400 text-sm">Choose your account type</p>

      <button
        onClick={() => {
          setRole("client");
          setScreen("client-login");
        }}
        className="w-full bg-slate-100 text-slate-900 py-3 rounded-2xl text-sm font-medium"
      >
        Client Login
      </button>

      <button
        onClick={() => {
          setRole("provider");
          setScreen("provider-login");
        }}
        className="w-full bg-emerald-500 text-slate-900 py-3 rounded-2xl text-sm font-bold hover:bg-emerald-400"
      >
        Provider Login
      </button>
    </div>
  );
}

/* ===== LOGIN COMPONENTS ===== */

function ProviderLogin({ setScreen, onLogin }) {
  const handleLogin = () => {
    let id = null;
    if (typeof window !== "undefined") {
      id = window.localStorage.getItem("demo-provider-id");
    }
    if (!id) {
      id = `provider-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("demo-provider-id", id);
      }
    }
    if (onLogin) onLogin(id);
  };

  return (
    <div className="flex flex-col gap-4 text-center">
      <h2 className="text-lg font-semibold">Provider Login</h2>
      <p className="text-slate-400 text-sm">
        Continue as a demo provider to accept and verify client jobs.
      </p>
      <button
        onClick={handleLogin}
        className="w-full bg-emerald-500 text-slate-900 py-3 rounded-2xl text-sm font-semibold"
      >
        Continue
      </button>
      <button
        onClick={() => setScreen("role-select")}
        className="text-slate-400 text-xs mt-2"
      >
        Back
      </button>
    </div>
  );
}

function ClientLogin({ setScreen, onLogin }) {
  const handleLogin = () => {
    let id = null;
    if (typeof window !== "undefined") {
      id = window.localStorage.getItem("demo-client-id");
    }
    if (!id) {
      id = `client-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("demo-client-id", id);
      }
    }
    if (onLogin) onLogin(id);
  };

  return (
    <div className="flex flex-col gap-4 text-center">
      <h2 className="text-lg font-semibold">Client Login</h2>
      <p className="text-slate-400 text-sm">
        Continue as a demo client to create and manage your ad placements.
      </p>
      <button
        onClick={handleLogin}
        className="w-full bg-emerald-500 text-slate-900 py-3 rounded-2xl text-sm font-semibold"
      >
        Continue
      </button>
      <button
        onClick={() => setScreen("role-select")}
        className="text-slate-400 text-xs mt-2"
      >
        Back
      </button>
    </div>
  );
}

function ClientDashboard({ setScreen }) {
  return (
    <div className="flex flex-col gap-6 text-center">
      <h2 className="text-lg font-semibold">Client Dashboard</h2>
      <p className="text-slate-400 text-sm">
        Create a new ad placement or manage your running campaigns.
      </p>
      <button
        onClick={() => setScreen("create-ad")}
        className="w-full bg-emerald-500 text-slate-900 py-3 rounded-2xl text-sm font-semibold"
      >
        Create New Ad
      </button>
      <button
        onClick={() => setScreen("ad-manager")}
        className="w-full bg-slate-700 text-slate-100 py-3 rounded-2xl text-sm"
      >
        View My Ads
      </button>
      <button
        onClick={() => setScreen("role-select")}
        className="text-slate-400 text-xs"
      >
        Logout
      </button>
    </div>
  );
}

/* ===== AD MANAGER VIEW (CLIENT) ===== */

function AdManagerView({ ads = [], clientId, setScreen, setSelectedAd }) {
  const ownAds = clientId
    ? ads.filter((ad) => ad.client_id === clientId)
    : ads;
  const hasAds = ownAds.length > 0;

  return (
    <div className="flex flex-col gap-6 text-center">
      <h2 className="text-lg font-semibold">Your Published Ads</h2>

      {!hasAds && (
        <p className="text-slate-500 text-sm">No ads published yet.</p>
      )}

      {hasAds && (
        <div className="space-y-3 max-h-80 overflow-y-auto text-left">
          {ownAds.map((ad) => (
            <div
              key={ad.id}
              className="bg-slate-800 rounded-2xl p-3 text-xs flex flex-col gap-2"
            >
              <div className="flex justify-between items-center">
                <span className="font-medium">{ad.title}</span>
                <span
                  className={`px-2 py-1 rounded-full text-[0.65rem] ${
                    ad.status === "open"
                      ? "bg-slate-700 text-slate-200"
                      : ad.status === "camera_ready"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-slate-500/30 text-slate-200"
                  }`}
                >
                  {ad.status && ad.status.toUpperCase()}
                </span>
              </div>
              <p className="text-slate-400">
                {ad.city}, {ad.country}
              </p>
              {ad.status === "camera_ready" ? (
                <button
                  className="mt-1 w-full bg-emerald-500 text-slate-900 py-2 rounded-xl text-xs font-semibold"
                  onClick={() => {
                    setSelectedAd(ad);
                    setScreen("client-live");
                  }}
                >
                  View Live Camera
                </button>
              ) : (
                <button
                  className="mt-1 w-full bg-slate-700 text-slate-100 py-2 rounded-xl text-xs"
                  disabled
                >
                  Waiting for provider…
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setScreen("client-dashboard")}
        className="text-slate-400 text-xs"
      >
        Back
      </button>
    </div>
  );
}

/* ===== PROVIDER DASHBOARD ===== */

function ProviderDashboard({ ads = [], setScreen, setSelectedAd }) {
  const openAds = ads.filter((ad) => ad.status === "open");

  return (
    <div className="flex flex-col gap-6 text-center">
      <h2 className="text-lg font-semibold">Provider Dashboard</h2>

      {openAds.length === 0 && (
        <p className="text-slate-500 text-sm">No jobs available.</p>
      )}

      {openAds.length > 0 && (
        <div className="space-y-3 max-h-80 overflow-y-auto text-left">
          {openAds.map((ad) => (
            <div
              key={ad.id}
              className="bg-slate-800 rounded-2xl p-3 text-xs flex flex-col gap-2"
            >
              <span className="font-medium">{ad.title}</span>
              <p className="text-slate-400">
                {ad.city}, {ad.country}
              </p>
              <button
                className="mt-1 w-full bg-emerald-500 text-slate-900 py-2 rounded-xl text-xs font-semibold"
                onClick={() => {
                  setSelectedAd(ad);
                  setScreen("provider-job-details");
                }}
              >
                View & Accept
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setScreen("role-select")}
        className="text-slate-400 text-xs"
      >
        Logout
      </button>
    </div>
  );
}

/* ===== PROVIDER JOB DETAILS ===== */

function ProviderJobDetails({ ad, setScreen, onAccept }) {
  if (!ad) {
    return (
      <div className="text-center text-slate-400 text-sm">
        No job selected.
      </div>
    );
  }

  const mediaUrl = ad.media_path
    ? supabase.storage.from("ad-media").getPublicUrl(ad.media_path).data
        .publicUrl
    : null;

  const isVideo = mediaUrl ? mediaUrl.endsWith(".mp4") : false;

  return (
    <div className="flex flex-col gap-6 text-center">
      <h2 className="text-lg font-semibold">Job Details</h2>

      {mediaUrl && (
        <div className="bg-slate-808 rounded-2xl overflow-hidden h-40 flex items-center justify-center">
          {isVideo ? (
            <video
              src={mediaUrl}
              autoPlay
              loop
              muted
              className="w-full h-full object-cover"
            />
          ) : (
            <img
              src={mediaUrl}
              className="w-full h-full object-cover"
              alt="Ad media"
            />
          )}
        </div>
      )}

      <div className="bg-slate-800 rounded-2xl p-4 text-xs text-left space-y-1">
        <p>
          <span className="text-slate-400">Title:</span> {ad.title}
        </p>
        <p>
          <span className="text-slate-400">Location:</span> {ad.address}, {" "}
          {ad.city}, {ad.country}
        </p>
        <p>
          <span className="text-slate-400">GPS:</span> {ad.gps || "N/A"}
        </p>
        <p>
          <span className="text-slate-400">Date:</span> {ad.date || "N/A"}
        </p>
        <p>
          <span className="text-slate-400">Time:</span> {ad.time || "N/A"}
        </p>
        <p>
          <span className="text-slate-400">Budget:</span> {ad.budget || "N/A"}
        </p>
      </div>

      <button
        onClick={() => onAccept && onAccept(ad)}
        className="w-full bg-emerald-500 text-slate-900 py-3 rounded-2xl text-sm font-semibold"
      >
        Accept & Start Camera
      </button>

      <button
        onClick={() => setScreen("provider-dashboard")}
        className="text-slate-400 text-xs"
      >
        Back
      </button>
    </div>
  );
}

/* ===== PROVIDER LIVE CAMERA VIEW ===== */

function ProviderLiveView({ ad, setScreen }) {
  // Provider sees only the ad material full-screen.
  // Camera runs in the background and is sent to the client via WebRTC.
  const mediaUrl = ad.media_path
    ? supabase.storage.from("ad-media").getPublicUrl(ad.media_path).data.publicUrl
    : null;
  const isVideo = mediaUrl ? mediaUrl.endsWith(".mp4") : false;

  const [connectionStatus, setConnectionStatus] = useState("initial");
  const signalingChannelRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function setupWebRTC() {
      try {
        setConnectionStatus("connecting");

        const channel = supabase.channel(`webrtc_ad_${ad.id}`);
        signalingChannelRef.current = channel;

        channel.on("broadcast", { event: "signal" }, (event) => {
          const payload = event.payload;
          if (!payload || payload.from === "provider") return;
          if (!providerPeerConnection) return;

          if (payload.type === "answer" && payload.sdp) {
            const desc = new RTCSessionDescription(payload.sdp);
            providerPeerConnection.setRemoteDescription(desc).catch((err) => {
              console.error("Error setting remote answer:", err);
            });
          } else if (payload.type === "ice-candidate" && payload.candidate) {
            providerPeerConnection
              .addIceCandidate(new RTCIceCandidate(payload.candidate))
              .catch((err) => {
                console.error("Error adding ICE candidate (provider):", err);
              });
          }
        });

        await channel.subscribe();

        // Ensure we have a localStream (camera). If it was already created on accept, reuse it.
        if (!localStream) {
          if (
            typeof navigator !== "undefined" &&
            navigator.mediaDevices?.getUserMedia &&
            typeof window !== "undefined" &&
            window.isSecureContext
          ) {
            localStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } else {
            console.warn("Camera API not available or insecure context for provider.");
          }
        }

        providerPeerConnection = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        if (localStream) {
          localStream.getTracks().forEach((track) => {
            providerPeerConnection.addTrack(track, localStream);
          });
        }

        providerPeerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            channel
              .send({
                type: "broadcast",
                event: "signal",
                payload: {
                  from: "provider",
                  type: "ice-candidate",
                  candidate: event.candidate,
                  adId: ad.id,
                },
              })
              .catch((err) => {
                console.error("Error sending ICE candidate (provider):", err);
              });
          }
        };

        const offer = await providerPeerConnection.createOffer();
        await providerPeerConnection.setLocalDescription(offer);

        await channel.send({
          type: "broadcast",
          event: "signal",
          payload: {
            from: "provider",
            type: "offer",
            sdp: offer,
            adId: ad.id,
          },
        });

        if (!cancelled) {
          setConnectionStatus("waiting-client");
        }
      } catch (err) {
        console.error("Provider WebRTC setup error:", err);
        if (!cancelled) setConnectionStatus("error");
      }
    }

    setupWebRTC();

    return () => {
      cancelled = true;
      if (signalingChannelRef.current) {
        supabase.removeChannel(signalingChannelRef.current);
      }
      if (providerPeerConnection) {
        providerPeerConnection.close();
        providerPeerConnection = null;
      }
    };
  }, [ad?.id]);

  return (
    <div className="flex flex-col gap-4 text-center">
      <h2 className="text-lg font-semibold">Ad Material Display</h2>

      {connectionStatus === "waiting-client" && (
        <p className="text-[0.65rem] text-emerald-300">
          Camera is active. Waiting for client to open live view…
        </p>
      )}
      {connectionStatus === "connecting" && (
        <p className="text-[0.65rem] text-slate-300">
          Setting up secure camera connection…
        </p>
      )}
      {connectionStatus === "error" && (
        <p className="text-[0.65rem] text-red-400">
          Camera connection error. Client may not see live video.
        </p>
      )}

      <div className="bg-black rounded-xl overflow-hidden h-64 flex items-center justify-center">
        {mediaUrl && isVideo ? (
          <video
            src={mediaUrl}
            autoPlay
            loop
            muted
            className="w-full h-full object-contain"
          />
        ) : mediaUrl ? (
          <img
            src={mediaUrl}
            className="w-full h-full object-contain"
            alt="Ad media"
          />
        ) : (
          <p className="text-slate-400 text-xs">No media available.</p>
        )}
      </div>

      <button
        onClick={() => setScreen("provider-dashboard")}
        className="w-full bg-slate-700 text-slate-100 py-3 rounded-2xl text-sm mt-2"
      >
        Back
      </button>
    </div>
  );
}

/* ===== CLIENT LIVE VIEW ===== */

function ClientLiveView({ ad, setScreen }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("waiting");
  const signalingChannelRef = useRef(null);

  useEffect(() => {
    let remoteStream = new MediaStream();

    async function setupClient() {
      try {
        setStatus("waiting");

        const channel = supabase.channel(`webrtc_ad_${ad.id}`);
        signalingChannelRef.current = channel;

        clientPeerConnection = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });

        clientPeerConnection.ontrack = (event) => {
          event.streams[0].getTracks().forEach((track) => {
            remoteStream.addTrack(track);
          });

          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;
          }
          setStatus("connected");
        };

        clientPeerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            channel
              .send({
                type: "broadcast",
                event: "signal",
                payload: {
                  from: "client",
                  type: "ice-candidate",
                  candidate: event.candidate,
                  adId: ad.id,
                },
              })
              .catch((err) => {
                console.error("Error sending ICE candidate (client):", err);
              });
          }
        };

        channel.on("broadcast", { event: "signal" }, async (event) => {
          const payload = event.payload;
          if (!payload || payload.from === "client") return;
          if (!clientPeerConnection) return;

          try {
            if (payload.type === "offer" && payload.sdp) {
              setStatus("connecting");
              const offerDesc = new RTCSessionDescription(payload.sdp);
              await clientPeerConnection.setRemoteDescription(offerDesc);
              const answer = await clientPeerConnection.createAnswer();
              await clientPeerConnection.setLocalDescription(answer);

              await channel.send({
                type: "broadcast",
                event: "signal",
                payload: {
                  from: "client",
                  type: "answer",
                  sdp: answer,
                  adId: ad.id,
                },
              });
            } else if (
              payload.type === "ice-candidate" &&
              payload.candidate
            ) {
              await clientPeerConnection.addIceCandidate(
                new RTCIceCandidate(payload.candidate)
              );
            }
          } catch (err) {
            console.error("Client signaling handling error:", err);
            setStatus("error");
          }
        });

        await channel.subscribe();
      } catch (err) {
        console.error("Client WebRTC setup error:", err);
        setStatus("error");
      }
    }

    setupClient();

    return () => {
      if (signalingChannelRef.current) {
        supabase.removeChannel(signalingChannelRef.current);
      }
      if (clientPeerConnection) {
        clientPeerConnection.close();
        clientPeerConnection = null;
      }
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = videoRef.current.srcObject.getTracks();
        tracks.forEach((t) => t.stop());
        videoRef.current.srcObject = null;
      }
    };
  }, [ad?.id]);

  const handleApprove = () => {
    setScreen("ad-manager");
  };

  const handleBack = () => {
    setScreen("ad-manager");
  };

  return (
    <div className="flex flex-col gap-4 text-center">
      <h2 className="text-lg font-semibold">Live Job Verification</h2>
      <p className="text-slate-400 text-xs">
        Confirm that the provider is displaying your ad in the correct location.
      </p>

      {status === "waiting" && (
        <p className="text-slate-500 text-xs">
          Waiting for provider to activate camera…
        </p>
      )}
      {status === "connecting" && (
        <p className="text-slate-500 text-xs">Connecting to live video…</p>
      )}
      {status === "error" && (
        <p className="text-red-400 text-xs">
          There was a problem setting up live video.
        </p>
      )}

      <div className="bg-black rounded-2xl overflow-hidden h-64 flex items-center justify-center">
        {status === "connected" ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <p className="text-slate-400 text-xs px-4">
            Live video will appear here once the provider&apos;s camera is
            connected.
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <button
          className="flex-1 bg-emerald-500 text-slate-900 py-3 rounded-2xl text-sm font-semibold"
          onClick={handleApprove}
        >
          Approve
        </button>
        <button
          className="flex-1 bg-slate-700 text-slate-100 py-3 rounded-2xl text-sm"
          onClick={handleBack}
        >
          Back
        </button>
      </div>
    </div>
  );
}

/* ===== CREATE AD VIEW (CLIENT) ===== */

function CreateAdView({ setScreen, setAds, clientId }) {
  const [title, setTitle] = useState("");
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [gps, setGps] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [budget, setBudget] = useState("");
  const [mediaFile, setMediaFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    setError("");

    if (!title || !country || !city || !address) {
      setError("Please fill in at least title, country, city and address.");
      return;
    }

    if (!clientId) {
      setError("Missing client ID. Please log in again.");
      return;
    }

    try {
      setLoading(true);

      let uploadedPath = null;

      if (mediaFile) {
        const fileExt = mediaFile.name.split(".").pop();
        const fileName = `ad-media/${clientId}/${Date.now()}.${fileExt}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from("ad-media")
          .upload(fileName, mediaFile);

        if (uploadError) throw uploadError;
        uploadedPath = uploadData.path;
      }

      const { data, error: insertError } = await supabase
        .from("ads")
        .insert([
          {
            title,
            country,
            city,
            address,
            gps,
            date,
            time,
            duration,
            budget,
            media_path: uploadedPath,
            status: "open",
            client_id: clientId,
          },
        ])
        .select("*")
        .single();

      if (insertError) throw insertError;

      setAds((prev ) => [data, ...prev]);

      setTitle("");
      setCountry("");
      setCity("");
      setAddress("");
      setGps("");
      setDate("");
      setTime("");
      setDuration("");
      setBudget("");
      setMediaFile(null);

      setScreen("ad-manager");
    } catch (err) {
      console.error("Error creating ad:", err);
      setError(err?.message || "Failed to create ad.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-center">
      <h2 className="text-lg font-semibold">Create New Ad</h2>
      <p className="text-slate-400 text-xs">
        Describe your placement and upload the creative you want displayed on
        the provider&apos;s tablet.
      </p>

      <div className="space-y-3 text-left text-xs max-h-80 overflow-y-auto pr-1">
        <div className="space-y-1">
          <label className="text-slate-400">Title</label>
          <input
            className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
            placeholder="Ad title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-slate-400">Country</label>
            <input
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
              placeholder="Country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-slate-400">City</label>
            <input
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
              placeholder="City"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-slate-400">Address</label>
          <input
            className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
            placeholder="Street & number"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <label className="text-slate-400">GPS (optional)</label>
          <input
            className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
            placeholder="Latitude, Longitude"
            value={gps}
            onChange={(e) => setGps(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-slate-400">Date</label>
            <input
              type="date"
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-slate-400">Time</label>
            <input
              type="time"
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-slate-400">Duration</label>
            <input
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
              placeholder="e.g. 30 min"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-slate-400">Budget</label>
            <input
              type="number"
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs outline-none"
              placeholder="Total budget"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-slate-400">Creative (image or video)</label>
          <input
            type="file"
            className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-xs file:mr-2 file:py-1 file:px-3 file:rounded-lg file:border-0 file:bg-slate-700 file:text-xs file:text-slate-100"
            accept="image/*,video/*"
            onChange={(e) => setMediaFile(e.target.files?.[0] || null)}
          />
        </div>
      </div>

      {error && (
        <p className="text-red-400 text-xs text-left mt-1">{error}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={loading}
        className="w-full bg-emerald-500 text-slate-900 py-3 rounded-2xl text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading ? "Publishing…" : "Publish Ad"}
      </button>

      <button
        onClick={() => setScreen("client-dashboard")}
        className="text-slate-400 text-xs mt-1"
      >
        Back
      </button>
    </div>
  );
}
