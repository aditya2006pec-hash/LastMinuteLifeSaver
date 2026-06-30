import { initializeApp } from "firebase/app";
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User 
} from "firebase/auth";
import { 
  getFirestore, 
  doc, 
  collection, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  orderBy,
  getDocFromServer,
  writeBatch
} from "firebase/firestore";
import firebaseConfig from "../../firebase-applet-config.json";

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore with Database ID if provided as mandated
export const db = (firebaseConfig as any).firestoreDatabaseId 
  ? getFirestore(app, (firebaseConfig as any).firestoreDatabaseId)
  : getFirestore(app);
export const auth = getAuth(app);

// Configure Google OAuth provider with scopes
export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope("https://www.googleapis.com/auth/calendar");
googleProvider.addScope("https://www.googleapis.com/auth/gmail.readonly");

// Memory cache for OAuth access tokens (Never store in localStorage for security)
let cachedAccessToken: string | null = null;
let isSigningIn = false;

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || null,
      isAnonymous: auth.currentUser?.isAnonymous || null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error("[Firestore Error Info]:", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Dry-run connection validation as mandated in Rules
export async function testFirestoreConnection() {
  const testPath = "users/test-connection-doc";
  try {
    await getDocFromServer(doc(db, "users", "test-connection-doc"));
    console.log("[Firestore] Connection verified successfully.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("offline")) {
      console.error("[Firestore] Client is offline. Please check firebase configurations.");
    }
  }
}

// Initialize Auth listener and check cache
export const initAuth = (
  onAuthSuccess: (user: User, token: string) => void,
  onAuthFailure: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        // Attempt to get token if stored by auth redirects, or trigger re-auth
        cachedAccessToken = null;
        onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      onAuthFailure();
    }
  });
};

// Initiate GSI sign in flow
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Google login succeeded but failed to extract OAuth access token");
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error("Sign in error:", error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};

// Database CRUD services wrapping with handleFirestoreError

// Save User Profile
export const saveUserProfile = async (userId: string, email: string, timezone: string) => {
  const userPath = `users/${userId}`;
  try {
    await setDoc(doc(db, "users", userId), {
      id: userId,
      email,
      timezone,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
};

// Fetch User Commitments
export const getCommitments = async (userId: string) => {
  const commitmentsPath = `users/${userId}/commitments`;
  try {
    const q = query(collection(db, "users", userId, "commitments"), orderBy("start", "asc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as any);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, commitmentsPath);
    return [];
  }
};

// Save a commitment
export const saveCommitment = async (userId: string, commitment: any) => {
  const commitmentPath = `users/${userId}/commitments/${commitment.id}`;
  try {
    await setDoc(doc(db, "users", userId, "commitments", commitment.id), {
      ...commitment,
      createdAt: commitment.createdAt || new Date().toISOString()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, commitmentPath);
  }
};

// Delete a commitment
export const deleteCommitment = async (userId: string, commitmentId: string) => {
  const path = `users/${userId}/commitments/${commitmentId}`;
  try {
    // Delete sub-tasks first
    const tasksPath = `users/${userId}/commitments/${commitmentId}/tasks`;
    let tasksSnapshot;
    try {
      tasksSnapshot = await getDocs(collection(db, "users", userId, "commitments", commitmentId, "tasks"));
    } catch (e) {
      console.error("Failed to getDocs for tasks subcollection", e);
      throw e;
    }
    const batch = writeBatch(db);
    tasksSnapshot.docs.forEach(taskDoc => {
      batch.delete(taskDoc.ref);
    });
    batch.delete(doc(db, "users", userId, "commitments", commitmentId));
    try {
      await batch.commit();
    } catch (e) {
      console.error("Failed to commit batch delete", e);
      throw e;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
};

// Fetch Tasks for a commitment
export const getTasks = async (userId: string, commitmentId: string) => {
  const tasksPath = `users/${userId}/commitments/${commitmentId}/tasks`;
  try {
    const q = query(collection(db, "users", userId, "commitments", commitmentId, "tasks"), orderBy("order", "asc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as any);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, tasksPath);
    return [];
  }
};

// Save or Update a single task
export const saveTask = async (userId: string, commitmentId: string, task: any) => {
  const taskPath = `users/${userId}/commitments/${commitmentId}/tasks/${task.id}`;
  try {
    await setDoc(doc(db, "users", userId, "commitments", commitmentId, "tasks", task.id), task, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, taskPath);
  }
};

// Save multiple tasks (e.g. during plan generation)
export const saveTasksBatch = async (userId: string, commitmentId: string, tasks: any[]) => {
  const tasksPath = `users/${userId}/commitments/${commitmentId}/tasks`;
  try {
    const batch = writeBatch(db);
    tasks.forEach(task => {
      const ref = doc(db, "users", userId, "commitments", commitmentId, "tasks", task.id);
      batch.set(ref, task);
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, tasksPath);
  }
};
