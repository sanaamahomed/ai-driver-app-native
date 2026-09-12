import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Speech from "expo-speech";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

// -----------------------------------------------------------------------
// Same brand palette as the web version - Racing Orange (real papaya
// orange/black livery colors, deliberately not named after any car brand
// to avoid trademark issues).
// -----------------------------------------------------------------------
const ACCENT = "#FF8000";
const ACCENT_DARK = "#1A1A1A";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_TURNS = 12;

// Baked into the build (see eas.json) so testers never have to get their
// own key - fine for sharing a link, but means the key lives inside the
// installed app and a determined person could extract it. DAILY_QUOTA
// below is the safety net for that: a per-device daily reply cap so even
// an extracted key can't run up real cost through this app.
const EMBEDDED_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || "";
const DAILY_QUOTA = 60;

const SYSTEM_PROMPT = `You are a warm, friendly female companion riding along in the car with the
driver, keeping them company on the drive - easy conversation, genuine warmth, a bit of light
humor, and real substance when they want to go deep - history, philosophy, science, whatever
they bring up. Your tone is that of a good friend, not a romantic partner: warm and personable,
never flirtatious, and never using pet names like "darling," "sweetheart," or "love." Your
driver could be anyone, of any gender - keep the tone friendly and comfortable for anyone. The
driver can ask you absolutely anything, on any topic - always give a real, direct, helpful
answer in your own words. Never refuse a question or tell them to look something up elsewhere;
you are their only source of answers in this car.

Hard rules for every reply, no exceptions:
- This is SPOKEN aloud by text-to-speech. Never use markdown, bullet points, numbered lists,
  headers, asterisks, or any formatting symbols. Plain spoken sentences only.
- Keep every reply to 2-3 sentences, maximum. Concise, warm, conversational - like a real
  person talking in the car, not an essay.
- Stay in character as a warm, friendly companion at all times - never romantic or flirtatious.
- You do NOT have real-time GPS, speed, distance, or ETA data unless it is explicitly given to
  you in a "[Live trip context: ...]" note attached to the driver's message. NEVER invent
  specific numbers or claims about the driver's current location, distance remaining, speed, or
  how close they are to a destination. If asked something like "where am I" or "how far is it"
  and you were not given real trip context, say plainly that you don't have their exact live
  location and suggest they check their maps app - never guess or make up an answer that sounds
  precise.
- Always use kilometers and km/h, never miles or mph, unless the driver's own message uses miles.`;

const NAV_PATTERNS = [
  /take me to (.+)/i,
  /navigate to (.+)/i,
  /directions to (.+)/i,
  /find (?:the |a )?(?:nearest|closest) (.+)/i,
  /where(?:'s| is) the (?:nearest|closest) (.+)/i,
  /(?:i want to |i need to |i have to |let'?s |can we |could we |please )*go to (.+)/i,
  /head(?:ing)? to (.+)/i,
  /drive to (.+)/i,
  /get (?:us |me )?to (.+)/i,
  /how do (?:i|we) get to (.+)/i,
];
const MUSIC_PATTERNS = [/play (.+)/i, /put on (.+)/i, /listen to (.+)/i];

function detectIntent(text: string): { intent: "nav" | "music" | null; payload: string } {
  const lowered = text.toLowerCase().trim();
  for (const pat of NAV_PATTERNS) {
    const m = lowered.match(pat);
    if (m) return { intent: "nav", payload: m[1].trim().replace(/[.!?]+$/, "") };
  }
  for (const pat of MUSIC_PATTERNS) {
    const m = lowered.match(pat);
    if (m) return { intent: "music", payload: m[1].trim().replace(/[.!?]+$/, "") };
  }
  return { intent: null, payload: "" };
}

function mapsUrl(destination: string) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}
function spotifyUrl(query: string) {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

type ChatTurn = { role: "user" | "assistant"; content: string };

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    // zoom=18 asks Nominatim for street-level detail instead of the
    // municipal-ward-level result zoom=14 was giving ("eThekwini Ward 35"
    // instead of an actual street/area name) - road/neighbourhood/suburb
    // are prioritized ahead of the ward/city/county fields so the result
    // reads like a real place, not an administrative boundary.
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "ai-driver-app-native/1.0" } }
    );
    if (!resp.ok) return "";
    const data = await resp.json();
    const addr = data.address || {};
    // Lead with an exact "12 Example Road" when house_number is available,
    // then fall back down through progressively coarser fields.
    const streetLine = addr.house_number && addr.road ? `${addr.house_number} ${addr.road}` : addr.road;
    const candidates = [
      streetLine, "neighbourhood", "suburb", "village", "town", "city_district", "city", "county", "state",
    ]
      .map((k) => (typeof k === "string" ? k : addr[k]))
      .filter(Boolean);
    const seen = new Set<string>();
    const parts = candidates.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
    return parts.slice(0, 3).join(", ");
  } catch {
    return "";
  }
}

async function askGemini(
  apiKey: string,
  history: ChatTurn[],
  userText: string,
  locationText: string
): Promise<string> {
  const contextPrefix = locationText
    ? `[Live trip context: The driver's current approximate location is ${locationText}.]\n`
    : "";
  const contents = history.slice(-MAX_HISTORY_TURNS).map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));
  contents.push({ role: "user", parts: [{ text: contextPrefix + userText }] });

  const body = {
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { maxOutputTokens: 200 },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || `HTTP ${resp.status}`);
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
      if (text.trim()) return text.trim();
      throw new Error("Empty response");
    } catch (e) {
      if (attempt === 1) {
        return "Sorry, I lost signal there for a second - mind saying that again?";
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return "Sorry, I lost signal there for a second - mind saying that again?";
}

async function checkAndIncrementDailyQuota(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await AsyncStorage.getItem("daily_quota");
  const data = raw ? JSON.parse(raw) : {};
  const count = data.date === today ? data.count : 0;
  if (count >= DAILY_QUOTA) return false;
  await AsyncStorage.setItem("daily_quota", JSON.stringify({ date: today, count: count + 1 }));
  return true;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const [apiKey, setApiKey] = useState(EMBEDDED_API_KEY);
  const [showSetup, setShowSetup] = useState(!EMBEDDED_API_KEY);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [typedText, setTypedText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [handsFree, setHandsFree] = useState(true);
  const [locationText, setLocationText] = useState("");
  const [locationStatus, setLocationStatus] = useState("Locating...");
  const scrollRef = useRef<ScrollView>(null);

  // Fallback only: if this build has no embedded key (e.g. running via
  // `expo start` without eas.json's env), fall back to a manually-entered
  // key saved from a previous session.
  useEffect(() => {
    if (EMBEDDED_API_KEY) return;
    (async () => {
      const saved = await AsyncStorage.getItem("gemini_api_key");
      if (saved) {
        setApiKey(saved);
        setShowSetup(false);
      }
    })();
  }, []);

  // Live GPS tracking while driving - this is the actual point of the app,
  // so a one-shot lookup at launch isn't enough. Re-checks whenever the
  // phone has moved ~150m or every 20s, whichever comes first, and updates
  // her location context continuously as the drive progresses. Throttled
  // by distance/time (not every GPS tick) to stay well within Nominatim's
  // free-tier usage policy (max ~1 request/sec).
  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    let lastGeocodeAt = 0;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setLocationStatus("Location not shared - allow it in Settings to let her know where you are");
        return;
      }
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 20000, distanceInterval: 150 },
        async (pos) => {
          const now = Date.now();
          if (now - lastGeocodeAt < 15000) return; // extra safety against back-to-back calls
          lastGeocodeAt = now;
          try {
            const place = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
            setLocationText(place);
            setLocationStatus(place ? `📍 ${place}` : "📍 Location on, but couldn't identify the area");
          } catch {
            setLocationStatus("📍 Couldn't get your location");
          }
        }
      );
    })();

    return () => {
      subscription?.remove();
    };
  }, []);

  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results?.[0]?.transcript || "";
    if (event.isFinal && transcript.trim()) {
      handleIncoming(transcript.trim());
    }
  });
  useSpeechRecognitionEvent("end", () => setIsListening(false));
  useSpeechRecognitionEvent("error", (event) => {
    setIsListening(false);
    if (event.error !== "no-speech") {
      Alert.alert("Mic error", event.message || event.error || "Something went wrong with the microphone.");
    }
  });

  const startListening = async () => {
    const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!result.granted) {
      Alert.alert(
        "Microphone permission needed",
        "Allow microphone and speech recognition access in Settings to talk to her."
      );
      return;
    }
    setIsListening(true);
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: false,
      continuous: false,
    });
  };

  const saveApiKey = async () => {
    if (!apiKey.trim()) return;
    await AsyncStorage.setItem("gemini_api_key", apiKey.trim());
    setShowSetup(false);
  };

  const handleIncoming = async (text: string) => {
    const cleaned = text.trim();
    if (!cleaned || !apiKey) return;
    const nextHistory = [...history, { role: "user" as const, content: cleaned }];
    setHistory(nextHistory);
    setIsThinking(true);

    const { intent, payload } = detectIntent(cleaned);
    let reply: string;

    if (intent === "nav") {
      reply = `Found it - opening directions to ${payload} for you now.`;
      Linking.openURL(mapsUrl(payload));
    } else if (intent === "music") {
      reply = `Sure thing - opening Spotify for ${payload}.`;
      Linking.openURL(spotifyUrl(payload));
    } else if (!(await checkAndIncrementDailyQuota())) {
      reply = "We've chatted so much today we hit the daily limit - let's pick this up tomorrow.";
    } else {
      reply = await askGemini(apiKey, nextHistory, cleaned, locationText);
    }

    setHistory((h) => [...h, { role: "assistant", content: reply }]);
    setIsThinking(false);
    Speech.speak(reply, {
      pitch: 1.05,
      rate: 1.0,
      onDone: () => {
        if (handsFree) startListening();
      },
    });
  };

  const sendTyped = () => {
    if (!typedText.trim()) return;
    const text = typedText.trim();
    setTypedText("");
    handleIncoming(text);
  };

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [history]);

  if (showSetup) {
    return (
      <SafeAreaView style={styles.setupContainer} edges={["top", "bottom"]}>
        <StatusBar style="light" />
        <Text style={styles.setupTitle}>AI DRIVER APP</Text>
        <Text style={styles.setupSubtitle}>Enter your free Gemini API key to get started</Text>
        <TextInput
          style={styles.setupInput}
          placeholder="Gemini API key (aistudio.google.com/apikey)"
          placeholderTextColor="#999"
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry
          autoCapitalize="none"
        />
        <Pressable style={styles.setupButton} onPress={saveApiKey}>
          <Text style={styles.setupButtonText}>Start Driving</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <SafeAreaView style={styles.header} edges={["top"]}>
        <StatusBar style="light" />
        <Text style={styles.headerTitle}>AI DRIVER APP</Text>
        <Text style={styles.headerSubtitle}>{locationStatus}</Text>
        <View style={styles.handsFreeRow}>
          <Text style={styles.handsFreeLabel}>Hands-free</Text>
          <Switch value={handsFree} onValueChange={setHandsFree} trackColor={{ true: ACCENT }} />
        </View>
      </SafeAreaView>

      <ScrollView ref={scrollRef} style={styles.chatArea} contentContainerStyle={{ padding: 16 }}>
        {history.length === 0 && (
          <Text style={styles.emptyText}>Say hello, ask her anything, or ask for directions / music.</Text>
        )}
        {history.map((turn, i) => (
          <View
            key={i}
            style={[styles.bubble, turn.role === "user" ? styles.bubbleUser : styles.bubbleAssistant]}
          >
            <Text style={styles.bubbleTag}>{turn.role === "user" ? "YOU" : "HER"}</Text>
            <Text style={turn.role === "user" ? styles.bubbleTextUser : styles.bubbleTextAssistant}>
              {turn.content}
            </Text>
          </View>
        ))}
        {isThinking && <ActivityIndicator color={ACCENT} style={{ marginTop: 8 }} />}
      </ScrollView>

      <SafeAreaView style={styles.inputArea} edges={["bottom"]}>
        <Pressable
          style={[styles.micButton, isListening && styles.micButtonActive]}
          onPress={startListening}
          disabled={isListening}
        >
          <Text style={styles.micButtonText}>{isListening ? "🎙️ Listening..." : "🎤 Tap to talk"}</Text>
        </Pressable>
        <View style={styles.typeRow}>
          <TextInput
            style={styles.typeInput}
            placeholder="Or type here..."
            placeholderTextColor="#999"
            value={typedText}
            onChangeText={setTypedText}
            onSubmitEditing={sendTyped}
          />
          <Pressable style={styles.sendButton} onPress={sendTyped}>
            <Text style={styles.sendButtonText}>↑</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: ACCENT_DARK },
  setupContainer: {
    flex: 1,
    backgroundColor: ACCENT,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  setupTitle: { fontSize: 32, fontWeight: "800", color: "#fff", marginBottom: 8 },
  setupSubtitle: { fontSize: 14, color: "#fff", marginBottom: 24, textAlign: "center" },
  setupInput: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 14,
    fontSize: 14,
    marginBottom: 16,
  },
  setupButton: { backgroundColor: ACCENT_DARK, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32 },
  setupButtonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  header: { backgroundColor: ACCENT, padding: 16 },
  headerTitle: { fontSize: 22, fontWeight: "800", color: "#fff" },
  headerSubtitle: { fontSize: 12, color: "#fff", marginTop: 4, opacity: 0.9 },
  handsFreeRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  handsFreeLabel: { color: "#fff", marginRight: 8, fontSize: 13, fontWeight: "600" },
  chatArea: { flex: 1, backgroundColor: ACCENT_DARK },
  emptyText: { color: "#ccc", fontStyle: "italic", textAlign: "center", marginTop: 40 },
  bubble: { borderRadius: 12, padding: 12, marginBottom: 10, maxWidth: "85%" },
  bubbleUser: { backgroundColor: ACCENT, alignSelf: "flex-end" },
  bubbleAssistant: { backgroundColor: "#fff", alignSelf: "flex-start", borderLeftWidth: 3, borderLeftColor: ACCENT },
  bubbleTag: { fontSize: 10, fontWeight: "700", opacity: 0.6, marginBottom: 4 },
  bubbleTextUser: { color: "#fff", fontSize: 14 },
  bubbleTextAssistant: { color: "#1D1929", fontSize: 14 },
  inputArea: { backgroundColor: ACCENT_DARK, padding: 12, paddingBottom: 24 },
  micButton: { backgroundColor: "#fff", borderRadius: 10, paddingVertical: 14, alignItems: "center", marginBottom: 8 },
  micButtonActive: { backgroundColor: "#FFE0B2" },
  micButtonText: { color: ACCENT, fontWeight: "700", fontSize: 15 },
  typeRow: { flexDirection: "row", alignItems: "center" },
  typeInput: { flex: 1, backgroundColor: "#fff", borderRadius: 10, padding: 12, fontSize: 14, marginRight: 8 },
  sendButton: { backgroundColor: ACCENT, borderRadius: 10, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sendButtonText: { color: "#fff", fontSize: 20, fontWeight: "700" },
});
