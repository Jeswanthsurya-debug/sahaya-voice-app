import { useEffect, useRef, useState } from "react";
import {
  Building2,
  Check,
  ChevronRight,
  Globe2,
  HelpCircle,
  Languages,
  LockKeyhole,
  MapPin,
  Mic,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { calmHeadlines, emergencySms, getLanguageOption, languageOptions, translations } from "./i18n";
import type { LanguageKey, SahayaCopy } from "./i18n";

type Contact = { id: string; name: string; phone: string };
type Coordinates = { latitude: number; longitude: number };
type EmergencySheet = { body: string; hasLocation: boolean } | null;
type Conversation = { transcript: string; reply: string } | null;

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  start: () => void;
  stop: () => void;
};

type RecognitionConstructor = new () => RecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }
}

const LANGUAGE_STORAGE = "sahaya_language";
const CONTACT_STORAGE = "sahaya_trusted_people";

function readLanguage(): LanguageKey | null {
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE) as LanguageKey | null;
    return value && languageOptions.some((item) => item.key === value) ? value : null;
  } catch {
    return null;
  }
}

function readContacts(): Contact[] {
  try {
    const value = window.localStorage.getItem(CONTACT_STORAGE);
    if (!value) return [];
    const parsed = JSON.parse(value) as Contact[];
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function writeContacts(contacts: Contact[]) {
  try {
    window.localStorage.setItem(CONTACT_STORAGE, JSON.stringify(contacts));
    return true;
  } catch {
    return false;
  }
}

function makeContact(): Contact {
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: "", phone: "" };
}

function padContacts(contacts: Contact[]) {
  const next = [...contacts];
  while (next.length < 3) next.push(makeContact());
  return next;
}

function cleanPhone(phone: string) {
  return phone.replace(/\D/g, "").slice(0, 10);
}

function validPhone(phone: string) {
  return /^\d{10}$/.test(phone);
}

function getPosition(): Promise<Coordinates | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 0 },
    );
  });
}

function openExternal(url: string) {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) window.location.href = url;
}

function makeSmsUrl(phone: string | string[], body: string) {
  const recipients = Array.isArray(phone) ? phone.map((item) => `+91${item}`).join(",") : `+91${phone}`;
  return `sms:${recipients}?body=${encodeURIComponent(body)}`;
}

function speakText(text: string, language: string, silent: boolean, onEnd?: () => void) {
  if (silent || !("speechSynthesis" in window)) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  utterance.rate = 0.78;
  utterance.pitch = 1.03;
  utterance.volume = 0.94;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
}

async function transcribeAudio(_blob: Blob | null, fallback: string) {
  // The static build uses the browser's local speech recognition; no server is required.
  return Promise.resolve(fallback.trim());
}

async function requestReply(message: string, language: LanguageKey) {
  // Keep the prototype deployable as a single static build until a server is configured.
  return Promise.resolve(message.trim() ? translations[language].fallbackReply : null);
}

function App() {
  const [language, setLanguage] = useState<LanguageKey | null>(() => readLanguage());
  const [contacts, setContacts] = useState<Contact[]>(() => readContacts());
  const [draftContacts, setDraftContacts] = useState<Contact[]>(() => padContacts(readContacts()));
  const [setupOpen, setSetupOpen] = useState(() => Boolean(readLanguage()) && readContacts().length < 3);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [emergencySheet, setEmergencySheet] = useState<EmergencySheet>(null);
  const [silentMode, setSilentMode] = useState(false);
  const [toast, setToast] = useState("");
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation>(null);
  const [recordingError, setRecordingError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [setupError, setSetupError] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [activeContactTest, setActiveContactTest] = useState("");
  const [mapsCoordinates, setMapsCoordinates] = useState<Coordinates | null>(null);

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTextRef = useRef("");
  const recordingActiveRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const transcriptionStartedRef = useRef(false);

  const currentLanguage = language ?? "en";
  const copy: SahayaCopy = translations[currentLanguage];
  const speechLanguage = getLanguageOption(currentLanguage).speech;
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!language || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => setMapsCoordinates({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => undefined,
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 },
    );
  }, [language]);

  const announce = (text: string) => speakText(text, speechLanguage, silentMode);

  const chooseLanguage = (next: LanguageKey) => {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE, next);
    } catch {
      // The language still works for this session if storage is unavailable.
    }
    const hasEnoughPeople = contacts.length >= 3;
    setLanguage(next);
    setLanguageOpen(false);
    setSetupOpen(!hasEnoughPeople);
    setDraftContacts(padContacts(contacts));
  };

  const openSetup = () => {
    setDraftContacts(padContacts(contacts));
    setFieldErrors({});
    setSetupError("");
    setSetupOpen(true);
  };

  const updateDraftContact = (id: string, key: "name" | "phone", value: string) => {
    setDraftContacts((current) => current.map((contact) => contact.id === id ? { ...contact, [key]: key === "phone" ? cleanPhone(value) : value } : contact));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[`${id}-${key}`];
      return next;
    });
  };

  const deleteDraftContact = (id: string) => {
    if (draftContacts.length <= 3) {
      setToast(copy.trustedMinimum);
      return;
    }
    setDraftContacts((current) => current.filter((contact) => contact.id !== id));
  };

  const saveTrustedPeople = () => {
    const errors: Record<string, string> = {};
    draftContacts.forEach((contact, index) => {
      const hasAnything = Boolean(contact.name.trim() || contact.phone);
      if (index < 3 || hasAnything) {
        if (!contact.name.trim()) errors[`${contact.id}-name`] = copy.nameError;
        if (!validPhone(contact.phone)) errors[`${contact.id}-phone`] = copy.phoneError;
      }
    });
    const valid = draftContacts.filter((contact) => contact.name.trim() && validPhone(contact.phone));
    if (Object.keys(errors).length || valid.length < 3) {
      setFieldErrors(errors);
      setSetupError(copy.saveAtLeast);
      return;
    }
    const saved = valid.slice(0, 5).map((contact) => ({ ...contact, name: contact.name.trim() }));
    if (!writeContacts(saved)) {
      setSetupError(copy.saveAtLeast);
      return;
    }
    setContacts(saved);
    setDraftContacts(saved);
    setSetupOpen(false);
    setSetupError("");
    setToast(copy.savedPeople);
  };

  const sendTestMessage = (contact: Contact) => {
    if (!contact.name.trim() || !validPhone(contact.phone)) {
      setToast(copy.phoneError);
      return;
    }
    setActiveContactTest(contact.id);
    openExternal(makeSmsUrl(contact.phone, copy.testMessageBody));
    window.setTimeout(() => setActiveContactTest(""), 1200);
  };

  const triggerEmergency = async () => {
    if (contacts.length < 3) {
      openSetup();
      setToast(copy.emergencySetupHint);
      return;
    }
    if (silentMode) navigator.vibrate?.([180, 80, 180]);
    setToast(copy.locationWorking);
    const position = await getPosition();
    const locationUrl = position ? `https://maps.google.com/?q=${position.latitude},${position.longitude}` : "";
    const body = position ? emergencySms[currentLanguage].withLocation(locationUrl) : emergencySms[currentLanguage].withoutLocation;
    openExternal("tel:112");
    openExternal(makeSmsUrl(contacts.map((contact) => contact.phone), body));
    setEmergencySheet({ body, hasLocation: Boolean(position) });
    setToast(position ? copy.emergencyOpened : copy.locationDenied);
  };

  const policeMapsUrl = mapsCoordinates
    ? `https://www.google.com/maps/search/police+station/@${mapsCoordinates.latitude},${mapsCoordinates.longitude},14z`
    : "https://www.google.com/maps/search/?api=1&query=police+station";
  const hospitalMapsUrl = mapsCoordinates
    ? `https://www.google.com/maps/search/hospital/@${mapsCoordinates.latitude},${mapsCoordinates.longitude},14z`
    : "https://www.google.com/maps/search/?api=1&query=hospital";

  const finishTranscription = async (audio: Blob | null) => {
    if (transcriptionStartedRef.current) return;
    transcriptionStartedRef.current = true;
    setListening(false);
    setTranscribing(true);
    const transcript = await transcribeAudio(audio, recordingTextRef.current);
    setTranscribing(false);
    transcriptionStartedRef.current = false;
    if (!transcript) {
      setRecordingError(true);
      setToast(copy.transcriptError);
      return;
    }
    setRecordingError(false);
    setTranscriptDraft(transcript);
  };

  const startRecording = async () => {
    if (listening || transcribing || replying) return;
    setConversation(null);
    setTranscriptDraft(null);
    setRecordingError(false);
    recordingTextRef.current = "";
    recordingActiveRef.current = true;
    stopRequestedRef.current = false;
    transcriptionStartedRef.current = false;
    setListening(true);
    setToast(copy.listening);

    try {
      const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
      if (stream && recordingActiveRef.current) {
        streamRef.current = stream;
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
          const blob = chunks.length ? new Blob(chunks, { type: recorder.mimeType || "audio/webm" }) : null;
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          recorderRef.current = null;
          void finishTranscription(blob);
        };
        recorder.start();
      }
    } catch {
      // Speech recognition can still provide the local demo transcript.
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Recognition) {
      const recognition = new Recognition();
      recognition.lang = speechLanguage;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let transcript = "";
        for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index][0].transcript;
        recordingTextRef.current = transcript;
      };
      recognition.onerror = () => setRecordingError(true);
      recognition.onend = () => {
        if (stopRequestedRef.current && !recorderRef.current) void finishTranscription(null);
      };
      recognitionRef.current = recognition;
      try { recognition.start(); } catch { setRecordingError(true); }
    } else if (!recorderRef.current) {
      recordingActiveRef.current = false;
      setListening(false);
      setRecordingError(true);
      setToast(copy.transcriptError);
    }
  };

  const stopRecording = () => {
    if (!listening) return;
    recordingActiveRef.current = false;
    stopRequestedRef.current = true;
    recognitionRef.current?.stop();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else void finishTranscription(null);
  };

  const confirmTranscript = async () => {
    const confirmed = transcriptDraft?.trim();
    if (!confirmed) return;
    setReplying(true);
    const reply = await requestReply(confirmed, currentLanguage) ?? copy.fallbackReply;
    setReplying(false);
    setLastReply(reply);
    setConversation({ transcript: confirmed, reply });
    setTranscriptDraft(null);
    announce(reply);
  };

  const repeatReply = () => {
    if (lastReply) announce(lastReply);
  };

  const sayAgain = () => {
    setTranscriptDraft(null);
    setRecordingError(false);
    void startRecording();
  };

  const renderHeader = () => (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-symbol"><ShieldCheck size={22} /></div>
        <div><div className="brand-name">Sahaya</div><div className="brand-caption">{copy.brandTagline}</div></div>
      </div>
      <div className="top-actions">
        <button className={`language-trigger ${languageOpen ? "is-open" : ""}`} type="button" onClick={() => setLanguageOpen((value) => !value)} aria-label={copy.languageMenu} title={copy.languageMenu}><Languages size={16} /><span>{getLanguageOption(currentLanguage).label}</span></button>
        <button className="top-icon-button" type="button" onClick={openSetup} aria-label={copy.trustedMenu} title={copy.trustedMenu}><Users size={18} /></button>
        <button className={`top-icon-button ${silentMode ? "is-on" : ""}`} type="button" onClick={() => setSilentMode((value) => !value)} aria-label={copy.silentMode} title={silentMode ? copy.silentOn : copy.silentOff}><Volume2 size={18} /></button>
        <button className="help-button" type="button" onClick={() => setHelpOpen((value) => !value)} aria-label={copy.helpTitle} title={copy.helpTitle}><HelpCircle size={17} /></button>
      </div>
      {languageOpen && <div className="language-menu"><div className="menu-title"><Globe2 size={14} /> {copy.languageMenu}</div>{languageOptions.map((option) => <button key={option.key} className={currentLanguage === option.key ? "is-selected" : ""} type="button" onClick={() => chooseLanguage(option.key)}>{option.label}<ChevronRight size={14} /></button>)}</div>}
      {helpOpen && <div className="help-popover" role="status"><div className="help-popover-title">{copy.helpTitle}</div><p>{copy.helpBody}</p><p>{copy.assistantNote}</p></div>}
    </header>
  );

  const renderLanguageSelection = () => (
    <main className="sakhi-app onboarding-app">
      <header className="topbar"><div className="brand-lockup"><div className="brand-symbol"><ShieldCheck size={22} /></div><div><div className="brand-name">Sahaya</div><div className="brand-caption">{translations.en.brandTagline}</div></div></div></header>
      <section className="onboarding-wrap"><div className="onboarding-panel"><div className="onboarding-kicker"><Languages size={15} /> Sahaya</div><h1>{translations.en.chooseLanguage}</h1><p>{translations.en.chooseLanguageHint}</p><div className="language-choice-grid">{languageOptions.map((option) => <button key={option.key} type="button" onClick={() => chooseLanguage(option.key)}><span>{option.label}</span><ChevronRight size={18} /></button>)}</div></div></section>
    </main>
  );

  const renderTrustedSetup = () => (
    <main className="sakhi-app setup-app">
      {renderHeader()}
      <section className="setup-wrap"><div className="setup-panel"><div className="setup-kicker"><Users size={15} /> {copy.trustedMenu}</div><div className="setup-title-row"><div><h1>{copy.trustedTitle}</h1><p>{copy.trustedIntro}</p></div><button className="close-settings" type="button" onClick={() => contacts.length >= 3 && setSetupOpen(false)} aria-label={copy.close}><X size={18} /></button></div><div className="setup-count">{copy.trustedMinimum} <span>{draftContacts.length} / 5</span></div><div className="contact-editor-list">{draftContacts.map((contact, index) => <div className="contact-editor" key={contact.id}><div className="contact-number">0{index + 1}</div><div className="contact-fields"><label><span>{copy.contactName}</span><input value={contact.name} onChange={(event) => updateDraftContact(contact.id, "name", event.target.value)} placeholder={copy.contactNamePlaceholder} autoComplete="off" />{fieldErrors[`${contact.id}-name`] && <small>{fieldErrors[`${contact.id}-name`]}</small>}</label><label><span>{copy.phoneNumber}</span><div className="phone-field"><strong>+91</strong><input value={contact.phone} onChange={(event) => updateDraftContact(contact.id, "phone", event.target.value)} inputMode="tel" maxLength={10} placeholder={copy.phonePlaceholder} autoComplete="tel" /></div>{fieldErrors[`${contact.id}-phone`] && <small>{fieldErrors[`${contact.id}-phone`]}</small>}</label><div className="contact-actions"><button type="button" className="test-message-button" onClick={() => sendTestMessage(contact)} disabled={activeContactTest === contact.id}><Send size={14} /> {activeContactTest === contact.id ? copy.tapSend : copy.testMessage}</button><button type="button" className="delete-contact-button" onClick={() => deleteDraftContact(contact.id)} aria-label={`${copy.delete} ${contact.name}`}><Trash2 size={17} /></button></div></div></div>)}</div>{draftContacts.length < 5 && <button className="add-person-button" type="button" onClick={() => setDraftContacts((current) => [...current, makeContact()])}><Plus size={17} /> {copy.addPerson}</button>}<p className="consent-line"><LockKeyhole size={16} /> {copy.consent}</p>{setupError && <div className="setup-error"><ShieldAlert size={16} /> {setupError}</div>}<button className="save-people-button" type="button" onClick={saveTrustedPeople}><Check size={18} /> {copy.savePeople}</button></div></section>
    </main>
  );

  if (!language) return renderLanguageSelection();
  if (setupOpen) return renderTrustedSetup();

  return (
    <main className="sakhi-app">
      {renderHeader()}
      <div className="content-wrap sahaya-content">
        <section className="intro-block sahaya-intro" aria-labelledby="sahaya-heading">
          <div className="scheme-kicker"><span /> 24 / 7 {copy.trustedMenu} <span /></div>
          <h1 id="sahaya-heading" className="calm-headline">{calmHeadlines[currentLanguage]}</h1>
          <p className="intro-copy">{copy.emergencySubtitle}. {copy.trustedIntro}</p>
          <button className="emergency-button" type="button" onClick={() => void triggerEmergency()}><span className="emergency-icon"><ShieldAlert size={31} /></span><span><strong>{copy.emergencyLabel}</strong><small>{copy.emergencySubtitle}</small></span><ChevronRight size={22} /></button>
          <div className="trusted-status"><Users size={16} /><span>{contacts.length} {copy.trustedMenu.toLowerCase()}</span><button type="button" onClick={openSetup}>{copy.edit}</button></div>
          <div className="location-buttons"><a className="place-button police-button" href={policeMapsUrl} target="_blank" rel="noopener noreferrer"><ShieldAlert size={22} /><span><strong>{copy.police}</strong><small>{copy.policeSubtitle}</small></span></a><a className="place-button hospital-button" href={hospitalMapsUrl} target="_blank" rel="noopener noreferrer"><Building2 size={22} /><span><strong>{copy.hospital}</strong><small>{copy.hospitalSubtitle}</small></span></a></div>
        </section>

        <section className="voice-stage" aria-label={copy.micTitle}>
          <div className="stage-topline"><span className="stage-label"><span className="live-dot" /> {transcribing ? copy.transcribing : replying ? copy.sahayaSays : listening ? copy.listening : copy.ready}</span></div>
          <div className={`voice-orbit ${listening ? "is-listening" : ""} ${transcribing || replying ? "is-speaking" : ""}`}><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-ring ring-three" /><div className="orbit-dot dot-one" /><div className="orbit-dot dot-two" /><button className="mic-button" type="button" onClick={listening ? stopRecording : () => void startRecording()} disabled={transcribing || replying} aria-label={listening ? copy.stopListening : copy.micTitle}><span className="mic-icon-wrap">{listening ? <Volume2 size={42} /> : <Mic size={42} />}</span><span className="mic-label">{listening ? copy.stopListening : copy.micTitle}</span></button></div>
          <div className="voice-status" aria-live="polite"><strong>{transcribing ? copy.transcribing : replying ? copy.sahayaSays : listening ? copy.listening : copy.ready}</strong><span>{copy.micSubtitle}</span></div>
          {recordingError && !transcriptDraft && <div className="recording-error"><ShieldAlert size={15} /> {copy.transcriptError}</div>}
          {transcriptDraft !== null && <div className="transcript-review"><div className="review-heading"><div><strong>{copy.transcriptTitle}</strong><span>{copy.transcriptHint}</span></div><Volume2 size={17} /></div><textarea value={transcriptDraft} onChange={(event) => setTranscriptDraft(event.target.value)} placeholder={copy.transcriptPlaceholder} /><div className="review-actions"><button className="confirm-transcript" type="button" onClick={() => void confirmTranscript()}><Check size={18} /> {copy.transcriptYes}</button><button className="again-button" type="button" onClick={sayAgain}><RotateCcw size={17} /> {copy.sayAgain}</button></div></div>}
        </section>

        {conversation && <section className="conversation-card" aria-live="polite"><div className="conversation-heading"><div><span>{copy.conversationHint}</span><strong>{copy.youSaid} + {copy.sahayaSays}</strong></div><button type="button" onClick={repeatReply}><Volume2 size={17} /> {copy.repeat}</button></div><div className="conversation-row user-row"><div className="conversation-label"><Mic size={15} /> {copy.youSaid}</div><p>{conversation.transcript}</p></div><div className="conversation-row reply-row"><div className="conversation-label"><ShieldCheck size={15} /> {copy.sahayaSays}</div><p>{conversation.reply}</p></div></section>}
      </div>
      <footer className="app-footer"><span><i /> <LockKeyhole size={12} /> {copy.footerPrivacy}</span><span>{copy.footerRates}</span></footer>
      {toast && <div className="toast-message" role="status"><MapPin size={16} /> {toast}</div>}
      {emergencySheet && <div className="sheet-backdrop" role="presentation"><section className="confirmation-sheet" role="dialog" aria-modal="true" aria-labelledby="send-sheet-title"><div className="sheet-handle" /><div className="sheet-title-row"><div><div className="sheet-kicker"><Send size={14} /> {copy.emergencyLabel}</div><h2 id="send-sheet-title">{copy.sendSheetTitle}</h2></div><button className="close-sheet-button" type="button" onClick={() => setEmergencySheet(null)} aria-label={copy.closeSheet}><X size={18} /></button></div><p className="sheet-body">{copy.sendSheetBody}</p>{!emergencySheet.hasLocation && <div className="sheet-location-warning"><MapPin size={16} /> {copy.locationDenied}</div>}<div className="sheet-contact-list">{contacts.map((contact) => <div className="sheet-contact" key={contact.id}><div className="sheet-contact-name"><Users size={17} /><strong>{contact.name}</strong><small>+91 {contact.phone}</small></div><div className="sheet-contact-actions"><button type="button" onClick={() => openExternal(makeSmsUrl(contact.phone, emergencySheet.body))}><Send size={16} /> {copy.sendTo(contact.name)}</button><button type="button" onClick={() => openExternal(`https://wa.me/91${contact.phone}?text=${encodeURIComponent(emergencySheet.body)}`)}><span className="whatsapp-mark">W</span> {copy.whatsapp}</button></div></div>)}</div><button className="sheet-done-button" type="button" onClick={() => setEmergencySheet(null)}>{copy.closeSheet}</button></section></div>}
    </main>
  );
}

export default App;