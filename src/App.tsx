import React, { useState, useEffect, useRef } from 'react';
import { Settings, Volume2, Upload, X, Play, Edit3, Save, Plus, VolumeX, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Firebase
import { auth, db, storage } from './firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

type SoundButtonConfig = {
  id: number;
  label: string;
  color: string;
  audioData: ArrayBuffer | null;
  audioMimeType: string | null;
  preloadedAudioUrl: string | null;
  imageUrl?: string | null;
};

// Load all audio files from src/assets/audio at build time
const PRELOADED_AUDIO = import.meta.glob('/src/assets/audio/*.{mp3,wav,ogg,m4a}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const PRELOADED_KEYS = Object.keys(PRELOADED_AUDIO);

const COLORS = [
  'bg-zinc-800', 'bg-red-600', 'bg-orange-600', 'bg-amber-500', 'bg-green-600',
  'bg-emerald-500', 'bg-teal-600', 'bg-cyan-600', 'bg-blue-600', 'bg-indigo-600',
  'bg-violet-600', 'bg-purple-600', 'bg-fuchsia-600', 'bg-pink-600', 'bg-rose-600',
];

/**
 * Converts a raw filename into a smart, simplified, visually appealing label.
 * Removes ugly prefixes (Voicy, strings of numbers), cleans up formatting, and applies custom overrides for perfection.
 */
function humanizeLabel(raw: string): string {
  let label = raw.replace(/\.[^/.]+$/, ''); // Strip file extension
  label = label.replace(/_[a-zA-Z0-9]*\d[a-zA-Z0-9]*$/, ''); // Remove trailing random alphanumeric IDs

  // Remove known ugly garbage
  label = label.replace(/^Voicy_/i, ''); 
  label = label.replace(/^\d+_/i, ''); // Leading numbers (e.g. 59359677)
  label = label.replace(/preview$/i, '');
  label = label.replace(/_by_.*$/i, ''); // Strip "_by_author"
  label = label.replace(/^dj /i, '');
  label = label.replace(/[-_]/g, ' '); // Replace separators
  label = label.trim();

  // Smart overrides for the exact default files to make them look perfect
  const customMap: Record<string, string> = {
    'baby want a bottle of beer per bottle': 'Baby Want a Bottle?',
    'from downtown': 'From Downtown!',
    'hes on fire': "He's on Fire!",
    'loser 1': 'Loser',
    'ronnie lightweight baby': 'Lightweight Baby!',
    'air horn': 'Air Horn',
    'what the hell is wrong with you guys': 'What Is Wrong With You?',
    'hank hill bwaaa': 'Hank Hill: Bwaah'
  };
  
  const lowerLabel = label.toLowerCase();
  for (const [key, val] of Object.entries(customMap)) {
    if (lowerLabel.includes(key)) return val;
  }

  // Automatic cleanup formatting (e.g. "Randy Savage - Oh yeah" -> "Randy Savage: Oh Yeah")
  label = label.replace(/ (?:-|–) /g, ': ');
  
  // Custom Title Casing
  const stopWords = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'is', 'in']);
  label = label
    .split(/\s+/)
    .map((word, i) => {
      const w = word.toLowerCase();
      if (i > 0 && stopWords.has(w)) return w;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');

  // Truncate ultra-long generic names just in case
  if (label.length > 30) label = label.substring(0, 27) + '...';

  // Make sure first letter is always capitalized
  return label.charAt(0).toUpperCase() + label.slice(1) || raw;
}

const DEFAULT_BUTTONS: SoundButtonConfig[] = Array.from({ length: 40 }, (_, i) => {
  const preloadedKey = PRELOADED_KEYS[i] || null;
  const preloadedUrl = preloadedKey ? PRELOADED_AUDIO[preloadedKey] : null;
  const rawName = preloadedKey ? preloadedKey.split('/').pop() || `Sound ${i + 1}` : `Sound ${i + 1}`;
  const label = preloadedUrl ? humanizeLabel(rawName) : `Sound ${i + 1}`;
  return {
    id: i + 1,
    label,
    color: preloadedUrl ? 'bg-emerald-500' : 'bg-zinc-800',
    audioData: null,
    audioMimeType: null,
    preloadedAudioUrl: preloadedUrl,
  };
});
export default function App() {
  const ITEMS_PER_PAGE = 20;
  const TOTAL_PAGES = 2;

  const [user, setUser] = useState<User | null>({ uid: 'Z6D9g0U0s0X0x0x0x0x0x0x0x0x0' } as User);
  const [boardName, setBoardName] = useState('HYPE BOARD');
  const [buttons, setButtons] = useState<SoundButtonConfig[]>(DEFAULT_BUTTONS);
  const [currentPage, setCurrentPage] = useState(1);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingButton, setEditingButton] = useState<SoundButtonConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [playingIds, setPlayingIds] = useState<Set<number>>(new Set());
  const [masterVolume, setMasterVolume] = useState(0.8);

  // Swipe detection state
  const [touchStartPos, setTouchStartPos] = useState<{x: number, y: number} | null>(null);
  const [slideDir, setSlideDir] = useState<1 | -1>(1);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = buttons.findIndex((btn) => btn.id === active.id);
      const newIndex = buttons.findIndex((btn) => btn.id === over.id);
      const reordered = arrayMove(buttons, oldIndex, newIndex) as SoundButtonConfig[];
      await saveBoardData(reordered);
    }
  };

  const audioPlayers = useRef<Record<number, HTMLAudioElement[]>>({});

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      // Auto-Pilot: Default to your specific studio account if not logged in
      const activeUser = currentUser || ({ uid: 'Z6D9g0U0s0X0x0x0x0x0x0x0x0x0' } as User); 
      setUser(activeUser);

      if (activeUser) {
        setIsLoading(true);
        try {
          const docRef = doc(db, 'user_configs', activeUser.uid);
          
          // Race between Firebase fetch and a 5-second timeout
          const docSnap = await Promise.race([
            getDoc(docRef),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase timeout')), 5000))
          ]) as any;
          
          if (docSnap && docSnap.exists()) {
            const data = docSnap.data();
            const stored = data.buttons as SoundButtonConfig[];
            setBoardName(data.boardName || 'HYPE BOARD');
            
            // Migration: if they had 20 items, expand to 40
            if (stored.length === 20) {
              stored.push(...DEFAULT_BUTTONS.slice(20));
            }

            // Sync logic: Ensure labels and colors are correct for default buttons
            const merged = stored.map((btn, i) => {
              const defaultBtn = DEFAULT_BUTTONS[i];
              let updatedLabel = btn.label;

              // Automatic migration
              const isUglyOldLabel = btn.label.includes('Voicy') || btn.label.includes('59359677') || btn.label.match(/^Baby Want A /) || btn.label === 'Hes On Fire' || btn.label === 'Ronnie Lightweight Baby';
              
              if (isUglyOldLabel) {
                updatedLabel = defaultBtn.label;
              }

              if (!btn.audioData && !btn.preloadedAudioUrl && defaultBtn.preloadedAudioUrl) {
                return {
                  ...btn,
                  preloadedAudioUrl: defaultBtn.preloadedAudioUrl,
                  label: btn.label === `Sound ${i + 1}` ? updatedLabel : updatedLabel,
                  color: btn.color === 'bg-zinc-800' ? defaultBtn.color : btn.color,
                };
              }

              return { ...btn, label: updatedLabel };
            });
            setButtons(merged);
          } else {
            console.log("No config found, using defaults");
            setButtons(DEFAULT_BUTTONS);
          }
        } catch (e) {
          console.error('Board initialization failed (likely offline/timeout):', e);
          setButtons(DEFAULT_BUTTONS); // Fail-safe to default buttons
        } finally {
          setIsLoading(false);
        }
      } else {
        setButtons(DEFAULT_BUTTONS);
        setIsLoading(false);
      }
    });

    return () => unsubscribeAuth();
  }, []);

  const saveBoardData = async (newButtons: SoundButtonConfig[], newName?: string) => {
    const finalButtons = newButtons || buttons;
    const finalName = newName || boardName;
    
    setButtons(finalButtons);
    if (newName) setBoardName(newName);

    if (user) {
      try {
        await setDoc(doc(db, 'user_configs', user.uid), { 
          buttons: finalButtons, 
          boardName: finalName 
        });
      } catch (e) {
        console.error('Failed to sync board data to Firestore', e);
      }
    }
  };

  /**
   * Plays the sound for a button, tracking it in playingIds for visual feedback.
   * Respects masterVolume and supports overlapping playback.
   */
  const playSound = (id: number) => {
    const btn = buttons.find((b) => b.id === id);
    if (!btn) return;
    const url = btn.preloadedAudioUrl || (btn.audioData as string); // Using audioData field to store the Firebase Storage URL
    if (!url) return;

    const audio = new Audio(url);
    audio.volume = masterVolume;

    if (!audioPlayers.current[id]) audioPlayers.current[id] = [];

    audio.onended = () => {
      audioPlayers.current[id] = audioPlayers.current[id].filter((a) => a !== audio);
      if (audioPlayers.current[id].length === 0) {
        setPlayingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    };

    audioPlayers.current[id].push(audio);
    audio.play().catch((e) => console.error('Error playing audio:', e));
    setPlayingIds((prev) => new Set([...prev, id]));
  };

  /** Stops all active sound playback and clears playing state */
  const stopAllSounds = () => {
    (Object.values(audioPlayers.current) as HTMLAudioElement[][]).forEach((players) => {
      players.forEach((audio) => { audio.pause(); audio.currentTime = 0; });
    });
    audioPlayers.current = {};
    setPlayingIds(new Set());
  };

  /**
   * In play mode, clicking an empty button opens the Edit Modal as an invitation to
   * assign a sound. In edit mode, all buttons open the Edit Modal.
   */
  const handleButtonClick = (btn: SoundButtonConfig) => {
    if (isEditMode) {
      setEditingButton(btn);
    } else if (!btn.audioData && !btn.preloadedAudioUrl) {
      setEditingButton(btn);
    } else {
      playSound(btn.id);
    }
  };

  const handleSaveEdit = async (updatedBtn: SoundButtonConfig, newAudioFile: File | null, newImageFile: File | null) => {
    // 1. Close modal IMMEDIATELY for best UX
    setEditingButton(null);

    try {
      let cloudAudioUrl = updatedBtn.audioData as unknown as string;
      let cloudImageUrl = updatedBtn.imageUrl;

      // 2. Perform background uploads if necessary
      if (user && (newAudioFile || newImageFile)) {
        if (newAudioFile) {
          const storageRef = ref(storage, `sounds/${user.uid}/button-${updatedBtn.id}-${Date.now()}`);
          await uploadBytes(storageRef, newAudioFile);
          cloudAudioUrl = await getDownloadURL(storageRef);
        }
        if (newImageFile) {
          const imageRef = ref(storage, `images/${user.uid}/button-${updatedBtn.id}-${Date.now()}`);
          await uploadBytes(imageRef, newImageFile);
          cloudImageUrl = await getDownloadURL(imageRef);
        }
      }

      // 3. Update local state
      const finalBtn = { ...updatedBtn, audioData: cloudAudioUrl as any, imageUrl: cloudImageUrl };
      const updatedButtonsList = buttons.map((b) => (b.id === finalBtn.id ? finalBtn : b));
      
      setButtons(updatedButtonsList);
      
      // 4. Sync to DB in background
      saveBoardData(updatedButtonsList).catch(e => console.error("Background sync failed:", e));
      
    } catch (e) {
      console.error('Failed to process button edit in background', e);
    }
  };

  const onTouchStart = (e: React.TouchEvent) => {
    setTouchStartPos({ x: e.targetTouches[0].clientX, y: e.targetTouches[0].clientY });
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartPos) return;
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;

    const distanceX = touchStartPos.x - endX;
    const distanceY = touchStartPos.y - endY;

    // Abort horizontal swipe if user is vertically scrolling mostly
    if (Math.abs(distanceY) > Math.abs(distanceX)) {
      setTouchStartPos(null);
      return;
    }

    const isLeftSwipe = distanceX > 50;
    const isRightSwipe = distanceX < -50;

    if (isLeftSwipe && currentPage < TOTAL_PAGES) {
      setSlideDir(1);
      setCurrentPage((p) => p + 1);
    }
    if (isRightSwipe && currentPage > 1) {
      setSlideDir(-1);
      setCurrentPage((p) => p - 1);
    }
    setTouchStartPos(null);
  };

  /*
  if (!user) {
    return <LoginScreen />;
  }
  */

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] bg-zinc-950 flex items-center justify-center text-zinc-400 select-none">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <Volume2 className="w-12 h-12" />
          <p className="text-xl font-mono uppercase tracking-widest">Loading Studio...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30 select-none">
      {/* Header */}
      <header className="border-b border-zinc-800/50 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.4)]">
              <Volume2 className="w-6 h-6 text-zinc-950" />
            </div>
            <div className="flex flex-col justify-center">
              {isEditMode ? (
                <input
                  type="text"
                  value={boardName}
                  onChange={(e) => setBoardName(e.target.value.toUpperCase())}
                  onBlur={() => saveBoardData(buttons, boardName)}
                  className="bg-zinc-800/50 border border-emerald-500/30 text-white text-3xl sm:text-4xl font-black tracking-tighter uppercase italic px-3 py-1 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 w-full max-w-[320px] leading-none"
                  placeholder="BOARD NAME"
                  autoFocus
                />
              ) : (
                <h1 className="text-3xl sm:text-4xl font-black tracking-tighter uppercase italic text-white leading-none">
                  {boardName}
                </h1>
              )}
            </div>
          </div>

          {/* Master Volume Slider */}
          <div className="flex items-center gap-2 flex-1 max-w-[220px]">
            <button
              onClick={() => setMasterVolume((v) => (v > 0 ? 0 : 0.8))}
              className="text-zinc-400 hover:text-zinc-100 transition-colors shrink-0 active:scale-95 p-2 -ml-2 rounded-full"
              title={masterVolume === 0 ? 'Unmute' : 'Mute'}
            >
              {masterVolume === 0 ? <VolumeX className="w-6 h-6 sm:w-5 sm:h-5" /> : <Volume2 className="w-6 h-6 sm:w-5 sm:h-5" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={masterVolume}
              onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
              className="w-full h-2 rounded-full appearance-none cursor-pointer accent-emerald-500 bg-zinc-700"
              title={`Volume: ${Math.round(masterVolume * 100)}%`}
            />
            <span className="text-xs text-zinc-500 font-mono w-8 shrink-0 text-right">
              {Math.round(masterVolume * 100)}%
            </span>
          </div>

          {/* Pagination Controls */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
            <button
              onClick={() => { setSlideDir(-1); setCurrentPage((p) => Math.max(1, p - 1)); }}
              disabled={currentPage === 1}
              className="p-1 sm:p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all"
            >
              <ChevronLeft className="w-6 h-6 sm:w-5 sm:h-5" />
            </button>
            <span className="text-xs font-mono font-medium text-zinc-400 px-2 w-[5rem] text-center">
              PG {currentPage}/{TOTAL_PAGES}
            </span>
            <button
              onClick={() => { setSlideDir(1); setCurrentPage((p) => Math.min(TOTAL_PAGES, p + 1)); }}
              disabled={currentPage === TOTAL_PAGES}
              className="p-1 sm:p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all"
            >
              <ChevronRight className="w-6 h-6 sm:w-5 sm:h-5" />
            </button>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={stopAllSounds}
              className="px-4 py-3 sm:py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 transition-all font-medium text-sm flex items-center gap-2"
            >
              <X className="w-5 h-5 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">Stop All</span>
            </button>
            <button
              onClick={() => setIsEditMode(!isEditMode)}
              className={`px-4 py-3 sm:py-2 rounded-lg active:scale-95 transition-all font-medium text-sm flex items-center gap-2 ${
                isEditMode
                  ? 'bg-emerald-500 text-zinc-950 shadow-[0_0_15px_rgba(16,185,129,0.4)]'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              }`}
            >
              <Settings className="w-5 h-5 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">{isEditMode ? 'Done Editing' : 'Edit Mode'}</span>
            </button>
            <button
              onClick={() => signOut(auth)}
              className="p-2 sm:p-2 rounded-lg bg-zinc-800 hover:bg-red-500/10 hover:text-red-400 text-zinc-500 transition-all"
              title="Logout"
            >
              <X className="w-5 h-5 sm:w-4 sm:h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <main 
        className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-16 sm:pt-12 sm:pb-24 overflow-x-hidden [touch-action:pan-y]"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentPage}
              initial={{ opacity: 0, x: slideDir * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: slideDir * -40 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              <SortableContext items={buttons.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE).map((b) => b.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6">
                  {buttons.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE).map((btn) => (
                    <SortableButton
                      key={btn.id}
                      btn={btn}
                      isEditMode={isEditMode}
                      isPlaying={playingIds.has(btn.id)}
                      onClick={() => handleButtonClick(btn)}
                    />
                  ))}
                </div>
              </SortableContext>
            </motion.div>
          </AnimatePresence>
        </DndContext>
      </main>

      {/* Edit Modal */}
      <AnimatePresence>
        {editingButton && (
          <EditModal
            button={editingButton}
            onClose={() => setEditingButton(null)}
            onSave={handleSaveEdit}
            masterVolume={masterVolume}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function SortableButton({
  btn,
  isEditMode,
  isPlaying,
  onClick,
}: {
  key?: React.Key;
  btn: SoundButtonConfig;
  isEditMode: boolean;
  isPlaying: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: btn.id,
  });

  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1 };
  const hasAudio = !!btn.audioData || !!btn.preloadedAudioUrl;
  const isEmpty = !hasAudio;

  const defaultShadow = "inset 0 2px 1px rgba(255,255,255,0.4), inset 0 -4px 4px rgba(0,0,0,0.3), 0 6px 0 rgba(0,0,0,0.6), 0 10px 15px rgba(0,0,0,0.4)";
  const hoverShadow = "inset 0 2px 1px rgba(255,255,255,0.6), inset 0 -4px 4px rgba(0,0,0,0.3), 0 8px 0 rgba(0,0,0,0.6), 0 15px 20px rgba(0,0,0,0.5), 0 0 30px rgba(255,255,255,0.4)";
  const tapShadow = "inset 0 8px 16px rgba(0,0,0,0.6), inset 0 4px 4px rgba(0,0,0,0.4), 0 1px 0 rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.4)";
  const dragShadow = "inset 0 2px 1px rgba(255,255,255,0.4), inset 0 -4px 4px rgba(0,0,0,0.3), 0 12px 0 rgba(0,0,0,0.6), 0 25px 30px rgba(0,0,0,0.6), 0 0 40px rgba(255,255,255,0.3)";

  // Empty button in play mode — shows a dashed "Add Sound" affordance
  if (isEmpty && !isEditMode) {
    return (
      <div ref={setNodeRef} style={style} className="relative">
        <motion.button
          {...attributes}
          {...listeners}
          onClick={onClick}
          initial={{ opacity: 0.35, boxShadow: defaultShadow, y: 0, scale: 1 }}
          animate={{
            boxShadow: isDragging ? dragShadow : defaultShadow,
            y: isDragging ? -5 : 0,
            scale: isDragging ? 1.05 : 1,
            opacity: isDragging ? 0.75 : 0.35,
          }}
          whileHover={!isDragging ? { opacity: 0.65, scale: 1.02 } : undefined}
          whileTap={!isDragging ? { scale: 0.96 } : undefined}
          className={`relative aspect-square rounded-2xl flex flex-col items-center justify-center p-4 border-2 border-dashed border-zinc-600 bg-zinc-900 w-full [-webkit-touch-callout:none] touch-manipulation ${isDragging ? 'cursor-grabbing' : 'cursor-pointer'}`}
        >
          <Plus className="w-8 h-8 text-zinc-500 mb-2 pointer-events-none" />
          <span className="text-xs text-zinc-500 font-medium text-center pointer-events-none">Add Sound</span>
        </motion.button>
      </div>
    );
  }

  const ringClass = isEditMode
    ? 'ring-2 ring-emerald-500/50 ring-offset-4 ring-offset-zinc-950'
    : isPlaying
    ? 'ring-2 ring-white/40 ring-offset-2 ring-offset-zinc-950'
    : '';

  return (
    <div ref={setNodeRef} style={style} className="relative">
      {/* Ripple rings when playing */}
      <AnimatePresence>
        {isPlaying && (
          <>
            <motion.div
              key="ring1"
              className="absolute inset-0 rounded-2xl border-2 border-white/40 pointer-events-none"
              initial={{ scale: 1, opacity: 0.7 }}
              animate={{ scale: 1.18, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, repeat: Infinity, ease: 'easeOut' }}
            />
            <motion.div
              key="ring2"
              className="absolute inset-0 rounded-2xl border-2 border-white/25 pointer-events-none"
              initial={{ scale: 1, opacity: 0.5 }}
              animate={{ scale: 1.32, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, repeat: Infinity, ease: 'easeOut', delay: 0.22 }}
            />
          </>
        )}
      </AnimatePresence>

      <motion.button
        {...attributes}
        {...listeners}
        initial={{ boxShadow: defaultShadow, y: 0, scale: 1, filter: 'brightness(1)' }}
        animate={{
          boxShadow: isDragging ? dragShadow : defaultShadow,
          y: isDragging ? -5 : 0,
          scale: isDragging ? 1.05 : 1,
          filter: isDragging ? 'brightness(1.1)' : isPlaying ? 'brightness(1.2)' : 'brightness(1)',
        }}
        whileHover={!isDragging ? { boxShadow: hoverShadow, y: -2, scale: 1.01, filter: 'brightness(1.15)' } : undefined}
        whileTap={!isDragging ? { boxShadow: tapShadow, y: 0, scale: 0.92, filter: 'brightness(0.9)' } : undefined}
        onClick={onClick}
        className={`
          relative aspect-square rounded-2xl flex flex-col items-center justify-center p-4 w-full
          border-t border-white/20 mb-2
          ${btn.color} ${isDragging ? 'cursor-grabbing z-50' : 'cursor-pointer'}
          ${ringClass}
          [-webkit-touch-callout:none] touch-manipulation overflow-hidden
        `}
      >
        {/* Background Image if set */}
        {btn.imageUrl && (
          <div className="absolute inset-0 z-0">
            <img src={btn.imageUrl} alt="" className="w-full h-full object-cover opacity-60" />
            <div className="absolute inset-0 bg-black/30" />
          </div>
        )}

        {/* Glossy overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-white/20 to-transparent opacity-50 pointer-events-none rounded-2xl z-10" />

        <div className="relative z-20 flex flex-col items-center justify-center">
          {isEditMode ? (
            <Edit3 className="w-8 h-8 mb-3 opacity-80 pointer-events-none drop-shadow-md" />
          ) : isPlaying ? (
            /* Animated waveform bars while sound is active */
            <div className="flex items-end gap-[3px] mb-3 h-8 pointer-events-none">
              {[0, 1, 2, 3].map((i) => (
                <motion.div
                  key={i}
                  className="w-1.5 bg-white rounded-full"
                  animate={{ height: ['25%', '100%', '45%', '75%', '25%'] }}
                  transition={{ duration: 0.55, repeat: Infinity, delay: i * 0.11, ease: 'easeInOut' }}
                />
              ))}
            </div>
          ) : (
            <Play className="w-8 h-8 mb-3 opacity-80 pointer-events-none drop-shadow-md" />
          )}

          <span className="text-center font-bold text-sm sm:text-base leading-tight drop-shadow-md line-clamp-3 pointer-events-none">
            {btn.label}
          </span>
        </div>

        {/* Edit mode pulse badge */}
        {isEditMode && (
          <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-emerald-400 animate-pulse pointer-events-none shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
        )}
      </motion.button>
    </div>
  );
}

function EditModal({
  button,
  onClose,
  onSave,
  masterVolume,
}: {
  button: SoundButtonConfig;
  onClose: () => void;
  onSave: (btn: SoundButtonConfig, audioFile: File | null, imageFile: File | null) => void;
  masterVolume: number;
}) {
  const [label, setLabel] = useState(button.label);
  const [color, setColor] = useState(button.color);
  
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(button.audioData as unknown as string);
  const [preloadedAudioUrl, setPreloadedAudioUrl] = useState<string | null>(button.preloadedAudioUrl);
  
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(button.imageUrl || null);
  
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Sound Search States
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<{ name: string; url: string }[]>([]);

  const stopPreview = () => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    setIsPreviewing(false);
  };

  useEffect(() => () => stopPreview(), []);

  const handlePreview = (urlOverride?: string) => {
    stopPreview();
    const url = urlOverride || (audioFile ? URL.createObjectURL(audioFile) : (audioUrl || preloadedAudioUrl));
    if (!url) return;
    const audio = new Audio(url);
    audio.volume = masterVolume;
    audio.onended = () => setIsPreviewing(false);
    previewAudioRef.current = audio;
    audio.play().catch(() => setIsPreviewing(false));
    setIsPreviewing(true);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchResults([]); // Reset previous results

    try {
      const targetUrl = `https://www.myinstants.com/en/search/?name=${encodeURIComponent(searchQuery)}`;
      
      // Try standard allorigins proxy first
      let response = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`);
      let data = await response.json();
      let html = data.contents;
      
      // Fallback: If contents is empty or missing, try raw mode
      if (!html) {
        console.warn("AllOrigins standard proxy empty, trying raw fallback...");
        response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`);
        html = await response.text();
      }

      if (!html) throw new Error("Could not fetch search results");
      
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const instantNodes = doc.querySelectorAll('.instant');
      
      const results: { name: string; url: string }[] = [];
      instantNodes.forEach((node) => {
        const name = node.querySelector('.instant-link')?.textContent?.trim() || 'Unknown';
        const onclick = node.querySelector('.small-button')?.getAttribute('onclick') || '';
        const match = onclick.match(/play\('(.+?)'/);
        if (match && match[1]) {
          results.push({
            name,
            url: `https://www.myinstants.com${match[1]}`
          });
        }
      });
      
      if (results.length === 0) {
        console.log("No sounds found for query:", searchQuery);
      }

      setSearchResults(results.slice(0, 15));
    } catch (error) {
      console.error('Search failed', error);
      alert('Sound search is currently unavailable. Please try again later or upload your own file.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleAudioChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAudioFile(file);
      setPreloadedAudioUrl(null);
      setAudioUrl(null);
    }
  };

  const handleSelectSearchResult = (res: { name: string; url: string }) => {
    setAudioUrl(res.url);
    setAudioFile(null);
    setPreloadedAudioUrl(null);
    setLabel(humanizeLabel(res.name));
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      setImageUrl(null);
    }
  };

  const handleClearAudio = () => {
    stopPreview();
    setAudioFile(null);
    setAudioUrl(null);
    setPreloadedAudioUrl(null);
    if (audioInputRef.current) audioInputRef.current.value = '';
  };

  const handleClearImage = () => {
    setImageFile(null);
    setImageUrl(null);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      stopPreview();
      // If we have a cloud search URL, we pass it as audioData
      const finalAudioData = audioUrl || button.audioData;
      await onSave({ ...button, label, color, preloadedAudioUrl, imageUrl, audioData: finalAudioData as any }, audioFile, imageFile);
    } catch (e) {
      console.error('Save failed', e);
    } finally {
      setIsSaving(false);
    }
  };

  const hasAudio = !!audioFile || !!audioUrl || !!preloadedAudioUrl;
  const hasImage = !!imageFile || !!imageUrl;
  const modalTitle = label.trim() || `Button ${button.id}`;

  const currentImageUrl = imageFile ? URL.createObjectURL(imageFile) : imageUrl;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Modal Header */}
        <div className="p-6 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="overflow-hidden">
            <h2 className="text-xl font-bold truncate">{modalTitle}</h2>
            <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider mt-0.5">
              Button {button.id} · Edit
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-400 hover:text-white shrink-0 ml-3"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="p-6 space-y-6 overflow-y-auto flex-1">
          {/* Label */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Button Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all font-bold"
              placeholder="e.g. Airhorn"
            />
          </div>

          {/* Color Picker */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Button Color</label>
            <div className="grid grid-cols-5 gap-3">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`aspect-square rounded-lg ${c} transition-transform ${
                    color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110' : 'hover:scale-105'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Audio Section */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Sound File</label>
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 flex flex-col gap-4">
              {PRELOADED_KEYS.length > 0 && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-zinc-500 uppercase tracking-wider">Select Pre-loaded Sound</label>
                  <select
                    value={preloadedAudioUrl || ''}
                    onChange={(e) => {
                      setPreloadedAudioUrl(e.target.value || null);
                      if (e.target.value) {
                        setAudioUrl(null);
                        setAudioFile(null);
                        stopPreview();
                      }
                    }}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                  >
                    <option value="">-- None --</option>
                    {PRELOADED_KEYS.map((key) => (
                      <option key={key} value={PRELOADED_AUDIO[key]}>
                        {humanizeLabel(key.split('/').pop() || key)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {hasAudio ? (
                <div className="flex items-center justify-between bg-zinc-900 p-3 rounded-lg border border-zinc-800">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
                      <Volume2 className="w-5 h-5 text-emerald-500" />
                    </div>
                    <div className="truncate">
                      <p className="font-medium text-sm truncate">
                        {audioFile ? audioFile.name : audioUrl ? 'Cloud Sound Loaded' : 'Pre-loaded Sound'}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {audioFile
                          ? (audioFile.size / 1024 / 1024).toFixed(2) + ' MB'
                          : 'Cloud Hosted'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Inline audio preview button */}
                    <button
                      onClick={isPreviewing ? stopPreview : handlePreview}
                      className={`p-2 rounded-lg transition-colors ${
                        isPreviewing
                          ? 'text-emerald-400 bg-emerald-400/10'
                          : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                      }`}
                      title={isPreviewing ? 'Stop Preview' : 'Preview Sound'}
                    >
                      {isPreviewing ? <X className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={handleClearAudio}
                      className="p-2 text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                      title="Remove Sound"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-4">
                  <p className="text-zinc-500 text-sm">No sound assigned to this button.</p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-xs text-zinc-500 uppercase">OR</span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>

              <input
                type="file"
                accept="audio/*"
                onChange={handleAudioChange}
                ref={audioInputRef}
                className="hidden"
                id={`audio-upload-${button.id}`}
              />
              <label
                htmlFor={`audio-upload-${button.id}`}
                className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg cursor-pointer transition-colors font-medium text-sm text-center"
              >
                <Upload className="w-4 h-4" />
                {audioFile || audioUrl ? 'Replace Custom Sound' : 'Upload Custom Sound'}
              </label>

              <div className="flex items-center gap-2 pt-2">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-xs text-zinc-500 uppercase tracking-widest">Cloud Search</span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>

              <div className="space-y-2">
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Search millions of sounds..."
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-3 pr-10 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <button
                    onClick={handleSearch}
                    disabled={isSearching}
                    className="absolute right-2 top-1.5 p-1 text-zinc-500 hover:text-white disabled:opacity-30"
                  >
                    {isSearching ? <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Plus className="w-4 h-4" />}
                  </button>
                </div>

                {searchResults.length > 0 && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden max-h-[200px] overflow-y-auto divide-y divide-zinc-800">
                    {searchResults.map((res, i) => (
                      <div key={i} className="flex items-center justify-between p-2 hover:bg-zinc-800 transition-colors">
                        <span className="text-xs text-zinc-300 truncate pr-2">{res.name}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handlePreview(res.url)}
                            className="p-1 text-zinc-500 hover:text-emerald-400 transition-colors"
                            title="Preview"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleSelectSearchResult(res)}
                            className="bg-zinc-800 hover:bg-emerald-600 px-2 py-1 rounded text-[10px] font-bold text-white transition-colors"
                          >
                            SELECT
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-xs text-zinc-500 uppercase tracking-widest">Visual Style</span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>

              {hasImage ? (
                <div className="relative aspect-video w-full rounded-xl overflow-hidden border border-zinc-800 group shadow-lg">
                  <img src={currentImageUrl || ''} className="w-full h-full object-cover" alt="Button Preview" />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={handleClearImage}
                      className="p-3 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-xl"
                      title="Remove Image"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-2">
                  <p className="text-zinc-500 text-xs">No image assigned.</p>
                </div>
              )}

              <input
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                ref={imageInputRef}
                className="hidden"
                id={`image-upload-${button.id}`}
              />
              <label
                htmlFor={`image-upload-${button.id}`}
                className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg cursor-pointer transition-colors font-medium text-sm text-center"
              >
                <Plus className="w-4 h-4" />
                {hasImage ? 'Replace Image' : 'Upload Button Image'}
              </label>
            </div>
          </div>
        </div>

        {/* Sticky footer — always visible without scrolling */}
        <div className="p-6 border-t border-zinc-800 bg-zinc-900/50 shrink-0">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full py-3 px-4 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-xl font-bold text-lg transition-colors flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.3)] disabled:opacity-50"
          >
            {isSaving ? (
              <div className="w-6 h-6 border-2 border-zinc-950/20 border-t-zinc-950 rounded-full animate-spin" />
            ) : (
              <>
                <Save className="w-5 h-5" />
                Save Changes
              </>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-zinc-950 flex items-center justify-center p-6 select-none font-sans">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500 mx-auto flex items-center justify-center shadow-[0_0_30px_rgba(16,185,129,0.4)] mb-4">
            <Volume2 className="w-10 h-10 text-zinc-950" />
          </div>
          <h1 className="text-3xl font-black italic uppercase tracking-tight text-white">Hype Board</h1>
          <p className="text-zinc-500 font-mono text-xs uppercase tracking-widest mt-1">Studio Cloud Login</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-zinc-900 p-8 rounded-3xl border border-zinc-800 shadow-2xl space-y-4">
          {error && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs font-medium">{error}</div>}
          
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest pl-1">Email Studio ID</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500" 
              placeholder="coach@hypeboard.com"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest pl-1">Access Passcode</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500" 
              placeholder="••••••••"
              required
            />
          </div>

          <button 
            type="submit"
            className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-2xl font-black uppercase tracking-tighter text-lg transition-all active:scale-95 shadow-[0_10px_20px_rgba(16,185,129,0.3)]"
          >
            {isRegistering ? 'Initialize Board' : 'Enter Studio'}
          </button>

          <button 
            type="button"
            onClick={() => setIsRegistering(!isRegistering)}
            className="w-full py-2 text-zinc-500 hover:text-zinc-300 text-xs font-medium transition-colors"
          >
            {isRegistering ? 'Already have a board? Log In' : 'No board yet? Create One'}
          </button>
        </form>
      </div>
    </div>
  );
}
