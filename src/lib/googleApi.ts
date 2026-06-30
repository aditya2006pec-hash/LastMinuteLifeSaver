import { GCalEvent, GmailMessage } from "../types";

// Fetch events from user's primary Google Calendar for the next 7 days
export async function fetchPrimaryCalendarEvents(accessToken: string): Promise<GCalEvent[]> {
  try {
    const timeMin = new Date().toISOString();
    // 7 days in the future
    const timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;
    
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const errorMsg = await response.text();
      console.error("[Google Calendar API Error]:", errorMsg);
      throw new Error(`Google Calendar API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return (data.items || []).map((item: any) => ({
      id: item.id,
      summary: item.summary || "No Title",
      start: {
        dateTime: item.start?.dateTime || item.start?.date,
        date: item.start?.date
      },
      end: {
        dateTime: item.end?.dateTime || item.end?.date,
        date: item.end?.date
      },
      description: item.description || "",
      location: item.location || ""
    }));
  } catch (error) {
    console.error("fetchPrimaryCalendarEvents failed:", error);
    throw error;
  }
}

// Fetch user's matching recent unread email snippets
export async function fetchUnreadGmailMessages(accessToken: string): Promise<GmailMessage[]> {
  try {
    const qParam = encodeURIComponent("is:unread (interview OR exam OR pitch OR meeting OR due OR deadline OR assignment)");
    const listUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=8&q=${qParam}`;
    
    // Step 1: list message IDs
    const listResponse = await fetch(listUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    if (!listResponse.ok) {
      console.warn("[Gmail API Error]: List failed", listResponse.statusText);
      return [];
    }

    const listData = await listResponse.json();
    const messages = listData.messages || [];
    
    if (messages.length === 0) return [];

    // Step 2: retrieve message details in parallel
    const details = await Promise.all(
      messages.map(async (msg: { id: string }) => {
        try {
          const detailUrl = `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`;
          const detailRes = await fetch(detailUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json"
            }
          });
          if (!detailRes.ok) return null;
          const detailData = await detailRes.json();
          
          const headers = detailData.payload?.headers || [];
          const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
          const from = headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
          const date = headers.find((h: any) => h.name === "Date")?.value || new Date().toISOString();
          
          return {
            id: detailData.id,
            snippet: detailData.snippet || "",
            subject,
            date,
            from
          };
        } catch (e) {
          console.error("Failed to load gmail item detail:", msg.id, e);
          return null;
        }
      })
    );

    return details.filter((item): item is GmailMessage => item !== null);
  } catch (error) {
    console.error("fetchUnreadGmailMessages failed:", error);
    return [];
  }
}

// Insert time block task event back into Google Calendar
export async function createGCalTimeBlock(
  accessToken: string, 
  title: string, 
  startISO: string, 
  durationMinutes: number, 
  description: string
): Promise<string> {
  // Guard the mutate action with window.confirm inside the calling component as mandated by structural user trust guidelines
  try {
    const endT = new Date(new Date(startISO).getTime() + durationMinutes * 60 * 1000);
    const body = {
      summary: `🚀 [Copilot Setup] - ${title}`,
      description: `Action planned by AI Life Copilot:\n\n${description}\n\nReview preparation checklist inside your active dashboard.`,
      start: {
        dateTime: startISO
      },
      end: {
        dateTime: endT.toISOString()
      },
      colorId: "5", // yellow/gold for preparation focus blocks!
      reminders: {
        useDefault: true
      }
    };

    const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[Google Calendar Push Failed]:", err);
      throw new Error(`Google Calendar scheduling failed: ${response.statusText}`);
    }

    const result = await response.json();
    return result.id;
  } catch (error) {
    console.error("createGCalTimeBlock failed:", error);
    throw error;
  }
}
