import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import Markdown from "react-markdown";
import { 
  googleSignIn, 
  initAuth, 
  logout, 
  saveUserProfile, 
  getCommitments, 
  saveCommitment, 
  deleteCommitment,
  getTasks, 
  saveTask, 
  saveTasksBatch,
  googleProvider,
  getAccessToken
} from "./lib/firebase";
import { 
  fetchPrimaryCalendarEvents, 
  fetchUnreadGmailMessages, 
  createGCalTimeBlock 
} from "./lib/googleApi";
import { User } from "firebase/auth";
import { Commitment, Task, CommitmentType, GCalEvent, GmailMessage, GCalEvent as types_GCalEvent } from "./types";
import { 
  ShieldAlert, 
  Calendar, 
  Mail, 
  CheckCircle2, 
  Clock, 
  TrendingUp, 
  Zap, 
  Sparkles, 
  Plus, 
  Trash2, 
  PlusCircle, 
  RotateCw, 
  LogOut, 
  User as UserIcon, 
  AlertTriangle,
  FileText,
  CalendarDays,
  Flame,
  HelpCircle
} from "lucide-react";

export default function App() {
  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  // App metrics & data lists
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [tasksMap, setTasksMap] = useState<{ [commitmentId: string]: Task[] }>({});
  
  // Workspace direct feeds for analysis
  const [rawCalendarEvents, setRawCalendarEvents] = useState<GCalEvent[]>([]);
  const [rawEmails, setRawEmails] = useState<GmailMessage[]>([]);
  
  // Dynamic UI States
  const [selectedCommitment, setSelectedCommitment] = useState<Commitment | null>(null);
  const [selectedTasks, setSelectedTasks] = useState<Task[]>([]);
  const [isSyncingWorkspace, setIsSyncingWorkspace] = useState(false);
  const [isAIOperating, setIsAIOperating] = useState(false);
  const [aiError, setAIError] = useState<string | null>(null);

  // Holistic AI summary Insights
  const [aiInsights, setAIInsights] = useState<{
    summary: string;
    highRiskCount: number;
    criticalInterventions: string[];
  }>({
    summary: "Sign in and sync Google Workspace to run the active Commitment Detection and failure risk assessment engine.",
    highRiskCount: 0,
    criticalInterventions: []
  });

  // Manual commitment addition drawer
  const [showAddManual, setShowAddManual] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<CommitmentType>("meeting");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newDesc, setNewDesc] = useState("");

  // Voice capture state
  const [isListening, setIsListening] = useState(false);

  // Formula explanation modal toggler
  const [showFormulaModal, setShowFormulaModal] = useState(false);

  // Initialize auth
  useEffect(() => {
    const unsubscribe = initAuth(
      async (firebaseUser, token) => {
        setUser(firebaseUser);
        setAccessToken(token);
        setNeedsAuth(false);
        setAuthLoading(false);
        // Load data from Firestore for this user
        await loadUserData(firebaseUser.uid);
      },
      () => {
        setUser(null);
        setAccessToken(null);
        setNeedsAuth(true);
        setAuthLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  // Sync / recalculate risk for all commitments when tasks or density change
  const runRiskRecalculationForAll = (currentCommitments: Commitment[], allTasks: { [key: string]: Task[] }) => {
    const updated = currentCommitments.map(comm => {
      const commTasks = allTasks[comm.id] || [];
      const newScore = calculateRiskScore(comm.start, commTasks, rawCalendarEvents.length, comm.type);
      return {
        ...comm,
        riskScore: newScore
      };
    });
    setCommitments(updated);
    
    // Save updated scores back to Firestore in background
    if (user) {
      updated.forEach(c => {
        if (c.riskScore !== commitments.find(orig => orig.id === c.id)?.riskScore) {
          saveCommitment(user.uid, c).catch(e => console.error("Recalc save failed", e));
        }
      });
    }
  };

  // Main Loader
  const loadUserData = async (uid: string) => {
    try {
      const loadedCommitments = await getCommitments(uid);
      const tempTasksMap: { [commitmentId: string]: Task[] } = {};
      
      for (const comm of loadedCommitments) {
        const commTasks = await getTasks(uid, comm.id);
        tempTasksMap[comm.id] = commTasks;
      }
      
      setCommitments(loadedCommitments);
      setTasksMap(tempTasksMap);

      if (loadedCommitments.length > 0) {
        setSelectedCommitment(loadedCommitments[0]);
        setSelectedTasks(tempTasksMap[loadedCommitments[0].id] || []);
      }
    } catch (err) {
      console.error("Failed loading persistent user details:", err);
    }
  };

  // Google Login click
  const handleLogin = async () => {
    setIsLoggingIn(true);
    setAIError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        const { user: firebaseUser, accessToken: token } = result;
        setUser(firebaseUser);
        setAccessToken(token);
        setNeedsAuth(false);
        
        // Setup initial user Profile
        await saveUserProfile(
          firebaseUser.uid, 
          firebaseUser.email || "", 
          Intl.DateTimeFormat().resolvedOptions().timeZone
        );
        
        // Import data
        await loadUserData(firebaseUser.uid);
        
        // Trigger auto-sync
        await handleWorkspaceSync(token, firebaseUser);
      }
    } catch (err: any) {
      console.error("Login failed:", err);
      setAIError(err.message || "OAuth login failed");
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Logout click
  const handleLogout = async () => {
    await logout();
    setUser(null);
    setAccessToken(null);
    setNeedsAuth(true);
    setCommitments([]);
    setTasksMap({});
    setRawCalendarEvents([]);
    setRawEmails([]);
    setSelectedCommitment(null);
    setSelectedTasks([]);
  };

  // Continuous Risk Prediction Formula (from Section 9)
  // Risk = 0.30*Proximity + 0.30*Unpreparedness + 0.15*HabitPenalty + 0.25*ScheduleDensity
  const calculateRiskScore = (startISO: string, tasks: Task[], densityCount: number, type: CommitmentType): number => {
    const now = new Date();
    const start = new Date(startISO);
    const diffHours = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
    
    // 1. Proximity (30 points maximum)
    let proximityScore = 0;
    if (diffHours <= 0) {
      proximityScore = 100;
    } else if (diffHours <= 12) {
      proximityScore = 100;
    } else if (diffHours <= 36) {
      proximityScore = 90;
    } else if (diffHours <= 72) {
      proximityScore = 65;
    } else if (diffHours <= 168) {
      proximityScore = 35;
    } else {
      proximityScore = 10;
    }

    // 2. Unpreparedness (30 points maximum - based on incomplete tasks ratio)
    let unpreparednessScore = 100;
    if (tasks.length > 0) {
      const completedCount = tasks.filter(t => t.isCompleted).length;
      unpreparednessScore = 100 - (completedCount / tasks.length * 100);
    }

    // 3. Habit penalty based on historic categories (15 points maximum)
    let habitScore = 40;
    if (type === "exam") habitScore = 95; // very high procrastination risks
    else if (type === "interview") habitScore = 85; 
    else if (type === "pitch") habitScore = 75;
    else if (type === "assignment") habitScore = 65;
    else if (type === "meeting") habitScore = 30;

    // 4. Schedule density penalty (25 points maximum)
    // Scale total events over next 7 days: e.g. 10+ events is 100% density
    const densityScore = Math.min(100, densityCount * 10);

    const weightedScore = (0.30 * proximityScore) + 
                          (0.30 * unpreparednessScore) + 
                          (0.15 * habitScore) + 
                          (0.25 * densityScore);

    return Math.min(100, Math.max(0, Math.round(weightedScore)));
  };

  // Google Workspace Scan & Sync
  const handleWorkspaceSync = async (activeToken: string, activeUser: User) => {
    if (!activeToken || !activeUser) return;
    setIsSyncingWorkspace(true);
    setAIError(null);
    try {
      // 1. Load Calendar Events
      const calendarData = await fetchPrimaryCalendarEvents(activeToken);
      setRawCalendarEvents(calendarData);

      // 2. Load Gmail messages
      const gmailData = await fetchUnreadGmailMessages(activeToken);
      setRawEmails(gmailData);

      // 3. Trigger backend multi-agent analyzes for commitments
      const response = await fetch("/api/ai/analyze-commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: calendarData,
          emails: gmailData,
          currentTime: new Date().toISOString()
        })
      });

      if (!response.ok) {
        throw new Error(`AI modeling failed: ${response.statusText}`);
      }

      const resData = await response.json();
      if (resData.success && resData.data) {
        const detectedEvents = resData.data;
        
        // Filter out those we already have saved to keep status states immutable
        const existingEventIds = new Set(commitments.map(c => c.calendarEventId));
        
        let newAddedCount = 0;
        const tasksToBatchSave: Array<{ commitmentId: string; taskList: Task[] }> = [];

        for (const detected of detectedEvents) {
          if (detected.isActive && !existingEventIds.has(detected.calendarEventId)) {
            // Find start/end from original calendar arrays
            const matchedCal = calendarData.find(e => e.id === detected.calendarEventId);
            const startStr = matchedCal?.start?.dateTime || new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
            const endStr = matchedCal?.end?.dateTime || new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();

            const commId = `comm_${detected.calendarEventId || Math.random().toString(36).substring(2, 9)}`;
            
            // Build task models
            const suggestedTasks = (detected.suggestedSteps || []).map((step: any, index: number) => ({
              id: `task_${commId}_${index}`,
              commitmentId: commId,
              title: step.title,
              durationMinutes: Number(step.durationMinutes) || 30,
              isCompleted: false,
              prerequisiteTaskId: index > 0 ? `task_${commId}_${index - 1}` : null,
              calendarBlockId: null,
              order: index
            }));

            // Calc predictive risk score
            const risk = calculateRiskScore(startStr, suggestedTasks, calendarData.length, detected.type);

            const newComm: Commitment = {
              id: commId,
              calendarEventId: detected.calendarEventId || "",
              title: detected.title,
              type: detected.type,
              start: startStr,
              end: endStr,
              riskScore: risk,
              riskRationale: detected.riskRationale,
              prepBrief: `### 🎯 Initial Preparation Brief\n\nAI detected this commitment from your workspace. Click **Generate Roadmap & Deep Research Brief** to retrieve a highly customized 4-part expert research file and cheat sheet.\n\n**Risk Context:** ${detected.riskRationale}`,
              isCompleted: false,
              createdAt: new Date().toISOString()
            };

            // Save Commitment and Tasks to Firestore
            await saveCommitment(activeUser.uid, newComm);
            await saveTasksBatch(activeUser.uid, commId, suggestedTasks);

            commitments.push(newComm);
            tasksMap[commId] = suggestedTasks;
            newAddedCount++;
          }
        }

        // Fetch refreshed lists
        await loadUserData(activeUser.uid);
        
        // Generate AI overall Weekly copy-brief
        await handleAIWeeksInsights(activeUser, commitments, calendarData.length);
      }
    } catch (err: any) {
      console.error("Workspace sync failed:", err);
      setAIError(`Active sync failed: ${err.message || err}`);
    } finally {
      setIsSyncingWorkspace(false);
    }
  };

  // Fetch Weekly Insights
  const handleAIWeeksInsights = async (activeUser: User, currentCommitments: Commitment[], densityCount: number) => {
    try {
      const response = await fetch("/api/ai/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitments: currentCommitments.map(c => ({
            title: c.title,
            type: c.type,
            riskScore: c.riskScore,
            start: c.start,
            isCompleted: c.isCompleted
          })),
          currentScheduleDensity: densityCount
        })
      });

      if (response.ok) {
        const insightsRes = await response.json();
        if (insightsRes.success && insightsRes.data) {
          setAIInsights(insightsRes.data);
        }
      }
    } catch (e) {
      console.warn("Could not generate week overview insights:", e);
    }
  };

  // Generate autonomous preparation roadmap & brief details using LLM Planning Agent
  const handleGenerateReadinessRoadmap = async () => {
    if (!selectedCommitment || !user) return;
    setIsAIOperating(true);
    setAIError(null);
    try {
      const response = await fetch("/api/ai/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: selectedCommitment.title,
          type: selectedCommitment.type,
          start: selectedCommitment.start,
          end: selectedCommitment.end
        })
      });

      if (!response.ok) throw new Error("Roadmap generation failed on our planning servers.");
      
      const res = await response.json();
      if (res.success && res.data) {
        const { tasks: generatedTasks, prepBrief } = res.data;

        // Map received items into standard task schema
        const mappedTasks = (generatedTasks || []).map((t: any, index: number) => ({
          id: `task_full_${selectedCommitment.id}_${index}`,
          commitmentId: selectedCommitment.id,
          title: t.title,
          durationMinutes: Number(t.durationMinutes) || 30,
          isCompleted: false,
          prerequisiteTaskId: index > 0 ? `task_full_${selectedCommitment.id}_${index - 1}` : null,
          calendarBlockId: null,
          order: index
        }));

        // Update selected commitment models
        const updatedCommitmentObj: Commitment = {
          ...selectedCommitment,
          prepBrief: prepBrief || selectedCommitment.prepBrief,
          // Recalculate score with new tasks
          riskScore: calculateRiskScore(selectedCommitment.start, mappedTasks, rawCalendarEvents.length, selectedCommitment.type)
        };

        // Batch save to Firestore
        await saveCommitment(user.uid, updatedCommitmentObj);
        await saveTasksBatch(user.uid, selectedCommitment.id, mappedTasks);

        // Update working state
        setTasksMap(prev => ({
          ...prev,
          [selectedCommitment.id]: mappedTasks
        }));

        const newCommsList = commitments.map(c => c.id === selectedCommitment.id ? updatedCommitmentObj : c);
        setCommitments(newCommsList);
        setSelectedCommitment(updatedCommitmentObj);
        setSelectedTasks(mappedTasks);

        // Update holistic insights
        await handleAIWeeksInsights(user, newCommsList, rawCalendarEvents.length);
      }
    } catch (err: any) {
      console.error("Roadmap generation crashed:", err);
      setAIError(`Fails to generate autonomous preparation steps: ${err.message || err}`);
    } finally {
      setIsAIOperating(false);
    }
  };

  // Toggle preparation sub-task checkbox
  const handleToggleTaskCheckbox = async (task: Task) => {
    if (!user || !selectedCommitment) return;
    
    const updatedTask = {
      ...task,
      isCompleted: !task.isCompleted
    };

    try {
      await saveTask(user.uid, selectedCommitment.id, updatedTask);
      
      // Update local task state
      const nextTasks = selectedTasks.map(t => t.id === task.id ? updatedTask : t);
      setSelectedTasks(nextTasks);
      
      const nextMap = {
        ...tasksMap,
        [selectedCommitment.id]: nextTasks
      };
      setTasksMap(nextMap);

      // Recalculate predictive risk continuous metrics immediately
      const nextRiskScore = calculateRiskScore(selectedCommitment.start, nextTasks, rawCalendarEvents.length, selectedCommitment.type);
      
      const updatedCommObj = {
        ...selectedCommitment,
        riskScore: nextRiskScore,
        isCompleted: nextTasks.length > 0 && nextTasks.every(t => t.isCompleted)
      };

      await saveCommitment(user.uid, updatedCommObj);

      const nextCommsList = commitments.map(c => c.id === selectedCommitment.id ? updatedCommObj : c);
      setCommitments(nextCommsList);
      setSelectedCommitment(updatedCommObj);

      // Refresh weekly overall insights
      await handleAIWeeksInsights(user, nextCommsList, rawCalendarEvents.length);
    } catch (error) {
      console.error("Toggle task failed:", error);
    }
  };

  // Scheduler Agent integration (Pushes tasks back as blocked focus slots)
  const handleScheduleTimeBlock = async (task: Task) => {
    if (!user || !accessToken || !selectedCommitment) {
      setAIError("Missing requirements for schedule!");
      return;
    }
    
    setIsAIOperating(true);
    setAIError(null);
    try {
      // Calculate a highly smart prep block time: 1 day before the commitment at 6:00 PM local time
      const commitmentStart = new Date(selectedCommitment.start);
      const focusBlockStart = new Date(commitmentStart.getTime() - 24 * 60 * 60 * 1000);
      focusBlockStart.setHours(18, 0, 0, 0); // 6:00 PM
      
      // If 6 PM yesterday is in the past, choose tonight at 7 PM
      if (focusBlockStart.getTime() < Date.now()) {
        const todayT = new Date();
        todayT.setHours(19, 0, 0, 0);
        focusBlockStart.setTime(todayT.getTime());
      }

      const descriptionMsg = `Autonomous focus block generated for high-risk item: "${selectedCommitment.title}"\nPrerequisite steps context: ${selectedCommitment.riskRationale}`;
      const calBlockId = await createGCalTimeBlock(
        accessToken,
        task.title,
        focusBlockStart.toISOString(),
        task.durationMinutes,
        descriptionMsg
      );

      // Update Task state with Calendar Block mapping
      const updatedTaskObj = {
        ...task,
        calendarBlockId: calBlockId
      };

      await saveTask(user.uid, selectedCommitment.id, updatedTaskObj);

      const nextTasks = selectedTasks.map(t => t.id === task.id ? updatedTaskObj : t);
      setSelectedTasks(nextTasks);
      setTasksMap(prev => ({
        ...prev,
        [selectedCommitment.id]: nextTasks
      }));

      // Refresh calendars in background
      const refreshedCal = await fetchPrimaryCalendarEvents(accessToken);
      setRawCalendarEvents(refreshedCal);
    } catch (error: any) {
      console.error("Scheduling failed:", error);
      setAIError(`Calendar push failed: ${error.message || error}`);
    } finally {
      setIsAIOperating(false);
    }
  };

  // Add Custom Manual deadline/commitment for testing
  const handleAddManualCommitment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newTitle || !newStart) return;

    try {
      const commId = `manual_comm_${Math.random().toString(36).substring(2, 9)}`;
      
      const emptyTasks: Task[] = [];
      const risk = calculateRiskScore(newStart, emptyTasks, rawCalendarEvents.length, newType);

      const newComm: Commitment = {
        id: commId,
        calendarEventId: "",
        title: newTitle,
        type: newType,
        start: new Date(newStart).toISOString(),
        end: newEnd ? new Date(newEnd).toISOString() : new Date(new Date(newStart).getTime() + 60 * 60 * 1000).toISOString(),
        riskScore: risk,
        riskRationale: newDesc || `Self-created target deadline. Use AI Planning Agent to draft the required preparation roadmap.`,
        prepBrief: `### 🎯 Self-Managed Preparation Goal\n\nClick **Generate Roadmap & Deep Research Brief** to utilize the server-side LLM Orchestrator to predict requirements.`,
        isCompleted: false,
        createdAt: new Date().toISOString()
      };

      await saveCommitment(user.uid, newComm);
      
      const list = [...commitments, newComm];
      setCommitments(list);
      setTasksMap(prev => ({ ...prev, [commId]: [] }));
      
      setSelectedCommitment(newComm);
      setSelectedTasks([]);

      // Reset fields
      setNewTitle("");
      setNewType("meeting");
      setNewStart("");
      setNewEnd("");
      setNewDesc("");
      setShowAddManual(false);

      // Refresh weekly overall insights
      await handleAIWeeksInsights(user, list, rawCalendarEvents.length);
    } catch (err) {
      console.error("Error adding manual goal:", err);
    }
  };

  // Voice Capture (Experimental Voice Assistant)
  const handleVoiceCapture = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setAIError("Your browser does not support the Web Speech API. Please try Google Chrome.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onresult = async (event: any) => {
      const transcript = event.results[0][0].transcript;
      setIsListening(false);
      setShowAddManual(true);
      
      // Show loading state in the form
      setNewTitle("Parsing voice input...");
      setNewDesc(transcript);

      try {
        const response = await fetch("/api/ai/parse-voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            transcript,
            currentTime: new Date().toISOString()
          })
        });
        
        const result = await response.json();
        
        if (result.success && result.data) {
          const { title, type, start, end, description } = result.data;
          setNewTitle(title || transcript);
          setNewType(type || 'other');
          
          if (start) {
            try {
              const startDate = new Date(start);
              if (!isNaN(startDate.getTime())) {
                const yyyy = startDate.getFullYear();
                const mm = String(startDate.getMonth() + 1).padStart(2, '0');
                const dd = String(startDate.getDate()).padStart(2, '0');
                const hh = String(startDate.getHours()).padStart(2, '0');
                const min = String(startDate.getMinutes()).padStart(2, '0');
                setNewStart(`${yyyy}-${mm}-${dd}T${hh}:${min}`);
              } else {
                setNewStart(start.substring(0, 16));
              }
            } catch (e) {
              setNewStart(start);
            }
          }
          if (end) {
            try {
              const endDate = new Date(end);
              if (!isNaN(endDate.getTime())) {
                const yyyy = endDate.getFullYear();
                const mm = String(endDate.getMonth() + 1).padStart(2, '0');
                const dd = String(endDate.getDate()).padStart(2, '0');
                const hh = String(endDate.getHours()).padStart(2, '0');
                const min = String(endDate.getMinutes()).padStart(2, '0');
                setNewEnd(`${yyyy}-${mm}-${dd}T${hh}:${min}`);
              } else {
                setNewEnd(end.substring(0, 16));
              }
            } catch (e) {
              setNewEnd(end);
            }
          }
          if (description) setNewDesc(description);
        } else {
          setNewTitle(transcript);
          setAIError(result.error || "Failed to parse voice input");
        }
      } catch (err) {
        console.error("Error parsing voice transcript:", err);
        setNewTitle(transcript);
        setAIError(err instanceof Error ? err.message : String(err));
      }
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error", event.error);
      setIsListening(false);
      if (event.error === 'not-allowed') {
        setAIError("Microphone access was denied. Please allow microphone permissions in the browser to use voice capture.");
      } else {
        setAIError(`Speech recognition error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.start();
  };

  // Delete/dismiss commitment from workspace
  const handleDeleteCommitmentBtn = async (commId: string) => {
    if (!user) return;
    
    setAIError(null);
    try {
      await deleteCommitment(user.uid, commId);
      const filtered = commitments.filter(c => c.id !== commId);
      setCommitments(filtered);
      
      if (selectedCommitment?.id === commId) {
        if (filtered.length > 0) {
          setSelectedCommitment(filtered[0]);
          setSelectedTasks(tasksMap[filtered[0].id] || []);
        } else {
          setSelectedCommitment(null);
          setSelectedTasks([]);
        }
      }
      
      await handleAIWeeksInsights(user, filtered, rawCalendarEvents.length);
    } catch (error: any) {
      console.error("Dismiss event failed:", error);
      setAIError(`Dismiss event failed: ${error.message || JSON.stringify(error)}`);
    }
  };

  // Helper styles for continuous Risk Meter color coding
  const getRiskColorInfo = (score: number) => {
    if (score >= 70) return { text: "text-rose-500", border: "border-rose-900/50", bg: "bg-rose-950/40", bar: "bg-rose-500", label: "Critical Risk" };
    if (score >= 40) return { text: "text-amber-500", border: "border-amber-900/50", bg: "bg-amber-950/40", bar: "bg-amber-500", label: "Warning Alert" };
    return { text: "text-emerald-500", border: "border-emerald-950", bg: "bg-emerald-950/20", bar: "bg-emerald-500", label: "Stable/Prepared" };
  };

  // Format Date string helper
  const formatDateStringObj = (iso: string) => {
    if (!iso) return "";
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  };

  // Render Loading Splash
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0d0f12] flex flex-col items-center justify-center space-y-4">
        <div className="w-12 h-12 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="font-mono text-xs text-slate-500">Retrieving secure credentials...</p>
      </div>
    );
  }

  // Render Authentication Window (Custom and official styling)
  if (needsAuth) {
    return (
      <div className="min-h-screen bg-[#0d0f12] flex flex-col items-center justify-center px-4 relative overflow-hidden" id="login-layout">
        {/* Decorative Grid Panel */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#151b22_1px,transparent_1px),linear-gradient(to_bottom,#151b22_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-30"></div>
        
        <div className="w-full max-w-md bg-[#12161b] border border-slate-800 rounded-2xl p-8 shadow-2xl relative z-10">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-14 h-14 bg-amber-950/60 border border-amber-500/30 rounded-2xl flex items-center justify-center mb-4">
              <Zap className="w-7 h-7 text-amber-500 animate-pulse" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-white">AI Life Copilot</h1>
            <p className="text-slate-400 text-sm mt-2 max-w-xs">
              Stop managing tasks. Let autonomous AI optimize your preparedness.
            </p>
          </div>

          <div className="space-y-4 mb-8">
            <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-800/60 flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-slate-200">Active Failure Prevention</p>
                <p className="text-[11px] text-slate-400 mt-1">Predicts calendar event failure risks and automatically schedules focus blocks before crunch time.</p>
              </div>
            </div>

            <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-800/60 flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-slate-200">Deep Autonomous Briefings</p>
                <p className="text-[11px] text-slate-400 mt-1">Scrapes news and course blueprints to construct custom cheat sheets and prep briefings.</p>
              </div>
            </div>
          </div>

          {/* Secure official login block with instruction constraints handled */}
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full flex items-center justify-center gap-3 bg-white text-slate-900 hover:bg-slate-100 font-medium py-3 px-4 rounded-xl transition duration-200 glow-btn"
            id="google-signin-btn"
          >
            {isLoggingIn ? (
              <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
            )}
            <span className="font-sans text-sm font-semibold text-slate-900">Sign in with Google</span>
          </button>

          {aiError && (
            <p className="mt-4 text-xs text-rose-500 text-center font-mono">{aiError}</p>
          )}

          <div className="mt-6 pt-5 border-t border-slate-800 text-center">
            <span className="text-[10px] text-slate-500 font-mono">WORKSPACE_OAUTH_ACTIVE // GOOGLE CLOUD INGRESS</span>
          </div>
        </div>
      </div>
    );
  }

  // Active Workspace Dashboard Layout
  return (
    <div className="min-h-screen bg-[#07090c] text-slate-100 flex flex-col font-sans relative" id="copilot-workspace">
      
      {/* HEADER SECTION */}
      <header className="sticky top-0 z-40 bg-[#0d1117]/90 backdrop-blur border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center justify-center">
            <Zap className="w-5 h-5 text-amber-500 animate-pulse" />
          </div>
          <div>
            <h1 className="font-display font-bold text-lg tracking-tight text-white flex items-center gap-2">
              AI Life Copilot
            </h1>
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Autonomous Active Execution Command</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={() => handleWorkspaceSync(accessToken!, user!)}
            disabled={isSyncingWorkspace}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition ${
              isSyncingWorkspace 
                ? "bg-slate-900 border-slate-800 text-slate-500" 
                : "bg-amber-950/20 border-amber-500/30 text-amber-500 hover:bg-amber-950/40 glow-btn"
            }`}
          >
            <RotateCw className={`w-3.5 h-3.5 ${isSyncingWorkspace ? "animate-spin" : ""}`} />
            {isSyncingWorkspace ? "Analyzing Feeds..." : "Sync Workspace Inbox / Calendar"}
          </button>

          <div className="h-6 w-px bg-slate-800"></div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs font-semibold text-slate-300">{user?.displayName || user?.email}</span>
              <span className="text-[9px] font-mono text-emerald-500 flex items-center gap-1 justify-end">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span> Live Link Verified
              </span>
            </div>
            
            {user?.photoURL ? (
              <img src={user.photoURL} alt="Avatar" className="w-8 h-8 rounded-full border border-slate-700" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center">
                <UserIcon className="w-4 h-4 text-slate-400" />
              </div>
            )}

            <button 
              onClick={handleLogout}
              className="p-1 px-2 rounded-lg hover:bg-slate-900 border border-transparent hover:border-slate-800 text-slate-400 hover:text-white transition"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Context-aware Nudge Banner */}
      <AnimatePresence>
        {commitments.filter(c => !c.isCompleted && c.riskScore >= 70 && new Date(c.start).getTime() - Date.now() < 24 * 60 * 60 * 1000).length > 0 && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="w-full bg-amber-500/10 border-b border-amber-500/20 py-2.5 px-6 flex items-center justify-center gap-3 backdrop-blur-sm z-30"
          >
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
            </span>
            <p className="text-xs font-mono text-amber-500">
              <strong className="font-sans text-amber-400">Context Reminder:</strong> You have {commitments.filter(c => !c.isCompleted && c.riskScore >= 70 && new Date(c.start).getTime() - Date.now() < 24 * 60 * 60 * 1000).length} high-risk commitments occurring within the next 24 hours. Execute AI Roadmaps immediately to mitigate risk.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* WORKSPACE CONTENTGRID */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-[1700px] w-full mx-auto" id="dashboard-grid">
        
        {/* LEFT COLUMN: RISK AND ANALYTICS METRICS (cols 3) */}
        <section className="lg:col-span-3 flex flex-col gap-6" id="left-sidebar-pane">
          
          {/* CRITICAL RISK CENTER HERO BAR */}
          <div className="bg-[#0b0e14] border border-slate-800/80 rounded-xl p-5 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-3xl -mr-12 -mt-12"></div>
            <h3 className="font-display text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4 text-amber-500" />
              Real-time Risk Center
            </h3>
            
            <div className="flex items-baseline justify-between mt-1">
              <div className="text-3xl font-display font-semibold text-amber-400">
                {commitments.filter(c => c.riskScore >= 70).length}
              </div>
              <span className="text-[10px] font-mono text-rose-500 border border-rose-900/40 bg-rose-950/20 px-2 py-0.5 rounded uppercase">Critical Action Items</span>
            </div>

            <div className="mt-4 p-3 bg-slate-900/40 rounded-lg border border-slate-800/40">
              <div className="flex justify-between text-[11px] text-slate-400">
                <span>Core Schedule Density:</span>
                <span className="font-mono text-amber-500 font-semibold">{rawCalendarEvents.length * 10}%</span>
              </div>
              <div className="w-full bg-slate-950 h-1 rounded overflow-hidden mt-1.5">
                <div className="bg-amber-500 h-full transition-all duration-300" style={{ width: `${Math.min(100, rawCalendarEvents.length * 10)}%` }}></div>
              </div>
            </div>

            <button 
              onClick={() => setShowFormulaModal(true)}
              className="mt-3 text-[10px] text-slate-500 font-mono flex items-center gap-1 hover:text-amber-500 cursor-pointer"
            >
              <HelpCircle className="w-3 h-3" /> View Predictive Math Formula
            </button>
          </div>

          {/* AI HOLISTIC INSIGHTS */}
          <div className="bg-[#0b0e14] border border-slate-800/80 rounded-xl p-5 flex-1 flex flex-col">
            <h3 className="font-display text-sm font-semibold text-slate-200 flex items-center gap-2 mb-4">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              Proactive AI Insights
            </h3>

            <div className="flex-1 space-y-4">
              {/* Holistic summary */}
              <div className="bg-indigo-950/10 border border-indigo-900/30 p-4 rounded-lg">
                <p className="text-xs leading-relaxed text-slate-300 italic">
                  "{aiInsights.summary}"
                </p>
              </div>

              {/* Interventions */}
              <div>
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider block mb-2">Predictive Core Interventions</span>
                {aiInsights.criticalInterventions.length === 0 ? (
                  <p className="text-[11px] text-slate-500 font-mono italic">No critical risk triggers. Sync raw feed data to refresh warnings...</p>
                ) : (
                  <div className="space-y-2.5">
                    {aiInsights.criticalInterventions.map((item, idx) => (
                      <div key={idx} className="bg-slate-900/50 border border-slate-800 p-3 rounded-lg flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                        <span className="text-[11px] text-slate-300 leading-normal font-mono">{item}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Manual item addition section trigger */}
            <div className="mt-8 pt-4 border-t border-slate-900 grid grid-cols-2 gap-2">
              <button
                onClick={() => setShowAddManual(true)}
                className="w-full bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 rounded-lg py-2 text-[10px] font-semibold flex items-center justify-center gap-1.5 transition"
              >
                <Plus className="w-3.5 h-3.5" /> Manual Goal
              </button>
              <button
                onClick={handleVoiceCapture}
                disabled={isListening}
                className={`w-full border rounded-lg py-2 text-[10px] font-semibold flex items-center justify-center gap-1.5 transition ${isListening ? "bg-amber-950/50 border-amber-500/50 text-amber-500" : "bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300"}`}
              >
                <div className={`w-2 h-2 rounded-full ${isListening ? "bg-amber-500 animate-ping" : "bg-current"}`}></div>
                {isListening ? "Listening..." : "Voice Capture"}
              </button>
            </div>
          </div>
        </section>

        {/* MIDDLE COLUMN: COMMITMENTS WORKSPACE LIST (cols 5) */}
        <section className="lg:col-span-5 flex flex-col gap-6" id="commitments-workspace-panel">
          <div className="bg-[#0b0e14] border border-slate-800 rounded-xl p-5 flex-1 flex flex-col">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-900">
              <h2 className="font-display font-medium text-sm text-slate-200 uppercase tracking-widest flex items-center gap-2">
                <Flame className="w-4 h-4 text-rose-500" />
                Active Commitments
              </h2>
              <span className="text-xs text-slate-500 font-mono">{commitments.length} Detected</span>
            </div>

            {aiError && (
              <div className="bg-rose-950/20 border border-rose-900/50 p-3 rounded-lg mb-4 text-xs font-mono text-rose-400 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
                <span>{aiError}</span>
              </div>
            )}

            {commitments.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
                <Calendar className="w-12 h-12 text-slate-700 stroke-1" />
                <div>
                  <p className="text-sm font-semibold text-slate-400">Workspace is empty</p>
                  <p className="text-xs text-slate-500 mt-1 max-w-xs leading-relaxed">
                    Sync your unread emails and Google Calendar, or click below to manually add a high-stakes meeting or exam goal.
                  </p>
                </div>
                <button
                  onClick={() => setShowAddManual(true)}
                  className="bg-amber-500/10 border border-amber-500/20 text-amber-500 px-4 py-2 rounded-lg text-xs font-medium hover:bg-amber-500/20 transition"
                >
                  Create Manual Goal
                </button>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-[60vh] lg:max-h-[75vh]">
                {commitments
                  .sort((a,b) => b.riskScore - a.riskScore)
                  .map((item) => {
                    const isSelected = selectedCommitment?.id === item.id;
                    const risk = getRiskColorInfo(item.riskScore);
                    const isManual = item.id.startsWith("manual_comm");
                    
                    return (
                      <div
                        key={item.id}
                        onClick={() => {
                          setSelectedCommitment(item);
                          setSelectedTasks(tasksMap[item.id] || []);
                        }}
                        className={`group border rounded-xl p-4 cursor-pointer transition relative overflow-hidden flex flex-col justify-between ${
                          isSelected 
                            ? "bg-[#12161c] border-amber-500/50 shadow-md"
                            : "bg-[#0b0e14]/40 border-slate-800 hover:border-slate-700"
                        }`}
                      >
                        {/* Selected overlay neon line */}
                        {isSelected && (
                          <div className="absolute top-0 bottom-0 left-0 w-1 bg-amber-500"></div>
                        )}

                        <div className="flex items-start justify-between gap-2.5">
                          <div className="space-y-1">
                            <h4 className="font-display text-sm font-semibold text-slate-200 group-hover:text-amber-500 transition line-clamp-1">
                              {item.title}
                            </h4>
                            <div className="flex items-center gap-2 flex-wrap text-[10px] text-slate-500 font-mono">
                              <span className="capitalize border border-slate-800 bg-slate-900 px-1.5 py-0.5 rounded text-slate-300">
                                {item.type}
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3 text-slate-500" />
                                {formatDateStringObj(item.start)}
                              </span>
                              {isManual && (
                                <span className="border border-indigo-900/40 bg-indigo-950/20 px-1.5 py-0.5 rounded text-indigo-400">
                                  Manual Target
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Risk Badge */}
                          <div className={`text-right ${risk.bg} ${risk.border} border rounded px-2.5 py-1 shrink-0`}>
                            <p className="text-[9px] font-mono uppercase tracking-wider text-slate-400">{risk.label}</p>
                            <p className={`text-sm font-mono font-bold ${risk.text}`}>{item.riskScore}%</p>
                          </div>
                        </div>

                        {/* Middle status meter */}
                        <div className="mt-3.5 pt-3.5 border-t border-slate-900/60 flex items-center justify-between gap-6">
                          <p className="text-[10.5px] text-slate-400 line-clamp-1 italic max-w-sm">
                            {item.riskRationale}
                          </p>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteCommitmentBtn(item.id);
                            }}
                            className="p-1 text-slate-600 hover:text-rose-500 transition shrink-0"
                            title="Dismiss commitment"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </section>

        {/* RIGHT COLUMN: DETAIL PLANNING & BRIEF (cols 4) */}
        <section className="lg:col-span-4" id="details-planning-panel">
          <AnimatePresence mode="wait">
            {!selectedCommitment ? (
              <div className="h-full bg-[#0b0e14] border border-slate-800/60 rounded-xl p-5 flex items-center justify-center text-center">
                <p className="text-xs text-slate-500 font-mono">Select an active commitment to load execution roadmaps...</p>
              </div>
            ) : (
              <motion.div
                key={selectedCommitment.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="bg-[#0b0e14] border border-slate-800 rounded-xl p-5 flex flex-col h-full justify-between"
              >
                
                {/* Details Header */}
                <div className="space-y-4 pb-5 border-b border-slate-900/50 relative">
                  {/* Subtle top glow based on risk */}
                  <div className={`absolute -top-5 -left-5 -right-5 h-1 ${
                    selectedCommitment.riskScore >= 70 ? 'bg-gradient-to-r from-amber-500/0 via-amber-500 to-amber-500/0' : 'bg-gradient-to-r from-slate-800/0 via-slate-600 to-slate-800/0'
                  }`} />
                  <div className="flex items-center justify-between">
                    <span className={`text-[9px] font-mono border px-3 py-1 rounded-full uppercase tracking-wider ${
                      selectedCommitment.riskScore >= 70 
                        ? 'text-amber-500 border-amber-900/50 bg-amber-950/20' 
                        : 'text-emerald-400 border-emerald-900/50 bg-emerald-950/20'
                    }`}>
                      Readiness Engine
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5 bg-slate-900/50 px-2 py-1 rounded-md">
                      <Calendar className="w-3 h-3" /> Due: {formatDateStringObj(selectedCommitment.start)}
                    </span>
                  </div>

                  <h3 className="font-display font-bold text-xl text-white leading-tight">
                    {selectedCommitment.title}
                  </h3>

                  <div className={`flex items-start gap-3 p-4 rounded-xl border ${
                    selectedCommitment.riskScore >= 70 
                      ? 'bg-amber-950/10 border-amber-900/30' 
                      : 'bg-slate-900/30 border-slate-800/60'
                  }`}>
                    <ShieldAlert className={`w-4 h-4 shrink-0 mt-0.5 ${
                      selectedCommitment.riskScore >= 70 ? 'text-amber-500' : 'text-slate-500'
                    }`} />
                    <p className={`text-xs leading-relaxed font-mono ${
                      selectedCommitment.riskScore >= 70 ? 'text-amber-200/80' : 'text-slate-300'
                    }`}>
                      {selectedCommitment.riskRationale}
                    </p>
                  </div>
                </div>

                {/* Sub-Tasks checklist */}
                <div className="flex-1 overflow-y-auto py-5 space-y-4 max-h-[35vh] lg:max-h-[48vh] pr-1">
                  
                  {/* Generate / Sync Roadmap trigger if empty */}
                  {selectedTasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center py-10 space-y-5 bg-slate-950/40 rounded-xl border border-dashed border-slate-800/80 p-6">
                      <div className="relative">
                        <Sparkles className="w-10 h-10 text-amber-500/60 animate-pulse relative z-10" />
                        <div className="absolute inset-0 bg-amber-500/20 blur-xl rounded-full" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-200">Execution Plan Available</p>
                        <p className="text-xs text-slate-500 mt-2 max-w-[200px] leading-relaxed mx-auto">
                          Generate a comprehensive preparation schedule and custom research brief.
                        </p>
                      </div>
                      <button
                        onClick={handleGenerateReadinessRoadmap}
                        disabled={isAIOperating}
                        className="bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold px-6 py-2.5 rounded-lg transition-all active:scale-95 shadow-[0_0_15px_rgba(245,158,11,0.2)] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isAIOperating ? "Drafting Roadmap..." : "Generate AI Execution Plan"}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between text-xs font-mono uppercase tracking-widest border-b border-slate-800/50 pb-2">
                        <span className="text-slate-400">Action Items</span>
                        <span className="text-amber-500 font-semibold bg-amber-950/30 px-2 py-0.5 rounded-sm">
                          {selectedTasks.filter(t => t.isCompleted).length} / {selectedTasks.length} Done
                        </span>
                      </div>

                      <div className="space-y-3">
                        {selectedTasks.map((task) => (
                          <div
                            key={task.id}
                            className={`group flex items-start gap-3 p-3.5 rounded-xl border transition-all ${
                              task.isCompleted 
                                ? "bg-slate-950/40 border-slate-900/50 text-slate-500 line-through opacity-60" 
                                : "bg-slate-900/40 border-slate-700/50 hover:bg-slate-800/60 hover:border-slate-600/50 shadow-sm"
                            }`}
                          >
                            <button
                              onClick={() => handleToggleTaskCheckbox(task)}
                              className="mt-1 shrink-0 hover:scale-110 transition-transform focus:outline-none"
                            >
                              <CheckCircle2 className={`w-5 h-5 ${
                                task.isCompleted ? "text-emerald-500 fill-emerald-950/40" : "text-slate-600 group-hover:text-amber-500/50"
                              }`} />
                            </button>

                            <div className="flex-1 space-y-1.5">
                              <p className={`text-[13px] font-medium leading-snug font-sans ${
                                task.isCompleted ? "text-slate-500" : "text-slate-200"
                              }`}>
                                {task.title}
                              </p>
                              <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1.5">
                                <Clock className="w-3 h-3 text-slate-600" />
                                {task.durationMinutes} Min
                              </p>
                            </div>

                            {/* Scheduler Agent Button */}
                            {!task.isCompleted && (
                              <button
                                onClick={() => handleScheduleTimeBlock(task)}
                                disabled={isAIOperating}
                                className={`shrink-0 flex items-center gap-1.5 border rounded-lg py-1.5 px-3 text-[10px] font-semibold transition-all ${
                                  task.calendarBlockId 
                                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
                                    : "bg-amber-500/10 hover:bg-amber-500 hover:text-amber-950 border-amber-500/30 text-amber-500"
                                }`}
                                title={task.calendarBlockId ? "Focus already blocked on Calendar" : "Schedule Focus block"}
                              >
                                {task.calendarBlockId ? (
                                  <>Added <CheckCircle2 className="w-3 h-3 ml-0.5 inline" /></>
                                ) : (
                                  <><CalendarDays className="w-3 h-3" /> Auto-Schedule</>
                                )}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Research / Brief text body */}
                  <div className="pt-6 mt-6 border-t border-slate-900/50">
                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest block mb-3">AI Research Brief</span>
                    <div className="bg-[#0b0e14] border border-slate-800/80 p-5 rounded-xl text-xs max-h-[35vh] overflow-y-auto leading-relaxed text-slate-300 font-sans markdown-body prose prose-invert custom-scrollbar prose-sm">
                      {selectedCommitment.prepBrief ? (
                        <Markdown>{selectedCommitment.prepBrief}</Markdown>
                      ) : (
                        <p className="text-slate-600 italic">No brief generated yet...</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Core actionable button details */}
                {selectedTasks.length > 0 && (
                  <div className="pt-4 mt-2 border-t border-slate-900/50">
                    <button
                      onClick={handleGenerateReadinessRoadmap}
                      disabled={isAIOperating}
                      className="w-full bg-[#151b22] hover:bg-[#1f2937] border border-slate-800 text-slate-300 text-xs font-semibold py-2.5 rounded-lg flex items-center justify-center gap-1.5 transition glow-btn"
                    >
                      <Sparkles className="w-4 h-4 text-amber-500" />
                      {isAIOperating ? "Drafting Roadmap..." : "Re-Draft AI Roadmap & Deep Research"}
                    </button>
                  </div>
                )}
                
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>

      {/* FORMULA MATHEMATICAL EXPLANATION MODAL */}
      <AnimatePresence>
        {showFormulaModal && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0f1319] border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl relative"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="font-display font-semibold text-white flex items-center gap-2">
                  <ShieldAlert className="w-5 h-5 text-amber-500" />
                  Predictive Continuous Risk Score Formula
                </h3>
                <button 
                  onClick={() => setShowFormulaModal(false)}
                  className="text-slate-400 hover:text-white font-mono text-xs cursor-pointer"
                >
                  ✕ Close
                </button>
              </div>

              <div className="space-y-3 text-slate-300 text-xs leading-relaxed font-mono">
                <p className="bg-slate-950 p-3 rounded border border-slate-900 text-center text-amber-400 font-semibold text-sm">
                  Risk = (0.30 × Proximity) + (0.30 × Unpreparedness) + (0.15 × HabitPenalty) + (0.25 × ScheduleDensity)
                </p>

                <div className="space-y-2 pt-2">
                  <p><strong className="text-slate-100">1. Proximity (30 points):</strong> Exponential curve peaking within 24 hours of the deadline. Triggers urgent preparation warnings as the meeting or exam nears.</p>
                  <p><strong className="text-slate-100">2. Unpreparedness (30 points):</strong> Ratio of uncompleted preparation steps. Resolves to 0 when all sub-tasks checklists are checked.</p>
                  <p><strong className="text-slate-100">3. Habit Penalty (15 points):</strong> Categories like Exams or Interviews carry a heavy anxiety multiplier while standard meetings have a lighter risk footprint.</p>
                  <p><strong className="text-slate-100">4. Schedule Density (25 points):</strong> Overlapping workload. If the lead-up time is packed with other events, preparation windows collapse, shooting the risk score up.</p>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* MANUAL GOAL/DEADLINE CREATION MODAL */}
      <AnimatePresence>
        {showAddManual && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0f1319] border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl relative"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="font-display font-semibold text-white">Add Manual Commitment / Goal</h3>
                <button 
                  onClick={() => setShowAddManual(false)}
                  className="text-slate-400 hover:text-white font-mono text-xs cursor-pointer"
                >
                  ✕ Close
                </button>
              </div>

              <form onSubmit={handleAddManualCommitment} className="space-y-4">
                <div>
                  <label className="block text-[10px] font-mono text-slate-500 uppercase mb-1">Commitment Title</label>
                  <input
                    type="text"
                    required
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g., PM Interview, Calculus 2 Final, Client Pitch"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-mono text-slate-500 uppercase mb-1">Category Type</label>
                    <select
                      value={newType}
                      onChange={(e) => setNewType(e.target.value as CommitmentType)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-amber-500"
                    >
                      <option value="interview">Interview</option>
                      <option value="exam">Exam</option>
                      <option value="meeting">Meeting</option>
                      <option value="pitch">Pitch</option>
                      <option value="assignment">Assignment</option>
                      <option value="goal">Goal</option>
                      <option value="habit">Habit</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-mono text-slate-500 uppercase mb-1">Due/Start Date</label>
                    <input
                      type="datetime-local"
                      required
                      value={newStart}
                      onChange={(e) => setNewStart(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-white focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-mono text-slate-500 uppercase mb-1">Description / Rationale</label>
                  <textarea
                    rows={3}
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder="Provide meeting context, firm name, review topics, or syllabus objectives..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-amber-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold transition rounded-lg py-2.5 text-xs inline-flex items-center justify-center gap-1"
                >
                  <PlusCircle className="w-4 h-4" /> Save Commitment Target
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
