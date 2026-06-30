export interface UserProfile {
  id: string;
  email: string;
  timezone: string;
  createdAt: string;
}

export type CommitmentType = 'interview' | 'exam' | 'meeting' | 'pitch' | 'assignment' | 'goal' | 'habit' | 'other';

export interface Commitment {
  id: string;
  calendarEventId: string;
  title: string;
  type: CommitmentType;
  start: string; // ISO string
  end: string;   // ISO string
  riskScore: number; // 0 - 100
  riskRationale: string;
  prepBrief: string; // Markdown summary/research brief
  isCompleted: boolean;
  createdAt: string;
}

export interface Task {
  id: string;
  commitmentId: string;
  title: string;
  durationMinutes: number;
  isCompleted: boolean;
  prerequisiteTaskId: string | null;
  calendarBlockId: string | null; // Google Calendar Event ID when pushed back
  order: number;
}

export interface HabitPenalty {
  category: CommitmentType;
  failureRate: number; // 0 (perfect) to 1.0 (high failure/procrastination)
  description: string;
}

export interface GCalEvent {
  id: string;
  summary: string;
  start: {
    dateTime?: string;
    date?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
  };
  description?: string;
  location?: string;
}

export interface GmailMessage {
  id: string;
  snippet: string;
  subject: string;
  date: string;
  from: string;
  body?: string;
}

export interface AIAnalysisResult {
  calendarEventId: string;
  title: string;
  isActive: boolean;
  type: CommitmentType;
  riskScore: number;
  riskRationale: string;
  suggestedSteps: Array<{
    title: string;
    durationMinutes: number;
  }>;
}

export interface WeeklyInsights {
  summary: string;
  highRiskCount: number;
  criticalInterventions: string[];
}
