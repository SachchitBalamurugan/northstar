// Fixture data matching contracts/types.ts. Used whenever a service fails /health.
import type { Insights, Proposal, Triage, CalEvent, KnowledgeFile } from "@contracts/types";

const now = new Date();
const at = (h: number, m = 0, dayOffset = 0) => {
  const d = new Date(now); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString();
};

export const mockProposals: Proposal[] = [
  { id: "p1", agent: "inbox", createdAt: at(8), type: "send_reply", title: "Reply to Prof. Lee about your extension",
    why: "She's your advisor and wrote 2 days ago.", urgency: 3, dueAt: at(17),
    payload: { to: "lee@univ.edu", subject: "Re: CS 201 project extension",
      body: "Hi Prof. Lee,\n\nThanks so much for understanding. Friday at 5pm works great. I'll send the draft by Wednesday so you can see progress.\n\nBest,\nMaya" },
    status: "pending" },
  { id: "p2", agent: "inbox", createdAt: at(8), type: "create_event", title: "◎ Study block: CS 201 project",
    why: "You focus best 2–5pm and this is due Friday.", urgency: 2, dueAt: at(23, 0, 3),
    payload: { start: at(14), end: at(14, 50), calendar: "primary" }, status: "pending" },
  { id: "p3", agent: "actions", createdAt: at(9), type: "fill_form", title: "Finish the Stripe internship application",
    why: "Applications close Sunday. 14 of 15 fields are filled.", urgency: 2, dueAt: at(23, 59, 4),
    payload: { url: "https://jobs.example.com/stripe-intern", fields: [
      { label: "Full name", value: "Maya Chen", confidence: 0.99 },
      { label: "Graduation year", value: "2028", confidence: 0.97 },
      { label: "Why Stripe?", value: "I love tools that make money feel simple…", confidence: 0.72 },
      { label: "Work authorization", value: "", confidence: 0.2 } ] }, status: "pending" },
  { id: "p4", agent: "memory", createdAt: at(3), type: "task", title: "Move tomorrow's 8am study block to 2pm",
    why: "You skipped the last three 8am blocks.", urgency: 1, payload: {}, status: "pending" },
  { id: "p5", agent: "inbox", createdAt: at(7), type: "unsubscribe", title: "Unsubscribe from Campus Deals",
    why: "You haven't opened 23 of their emails.", urgency: 1, payload: { url: "https://deals.example.com/unsub" }, status: "pending" },
];

export const mockInsights: Insights = {
  nextThing: { title: "Outline the CS 201 project", why: "It's due Friday and you have no time blocked yet.", minutes: 25, proposalId: "p2", dueAt: at(23, 0, 3) },
  cards: mockProposals.filter(p => p.agent === "memory"),
};

export const mockTriage: Triage = {
  needsYou: [
    { id: "e1", from: "Prof. Lee", fromRole: "advisor", subject: "Re: CS 201 project extension", snippet: "Friday at 5pm works. Can you send a draft by…", receivedAt: at(9, 0, -2), dueAt: at(17) },
    { id: "e2", from: "Financial Aid Office", fromRole: "admin", subject: "Verification form due Friday", snippet: "Please submit the attached verification form…", receivedAt: at(11, 0, -1), dueAt: at(17, 0, 3) },
    { id: "e3", from: "Stripe Recruiting", fromRole: "recruiter", subject: "Your online assessment invite", snippet: "Complete the assessment within 7 days…", receivedAt: at(8, 30), dueAt: at(23, 59, 6) },
  ],
  fyi: [
    { id: "e4", from: "Robotics Club", fromRole: "club", subject: "Thursday meeting moved to 6pm", snippet: "Same room, new time.", receivedAt: at(10) },
    { id: "e5", from: "TA Jordan", fromRole: "TA", subject: "Office hours notes", snippet: "Slides from today are posted.", receivedAt: at(12) },
  ],
  ignored: 41,
};

export const mockToday: CalEvent[] = [
  { id: "c1", title: "MATH 220 lecture", start: at(10), end: at(11, 15) },
  { id: "c2", title: "◎ Study block: CS 201 project", start: at(14), end: at(14, 50), northstar: true },
  { id: "c3", title: "Robotics club", start: at(18), end: at(19, 30) },
];

export const mockKnowledge: KnowledgeFile[] = [
  { name: "README.md", content: "# Maya\n\nCS sophomore. ADHD. Works best with short, clear tasks.\n\n- Lives on campus\n- Advisor: Prof. Lee\n" },
  { name: "goals.md", content: "# This semester\n\n- Land a summer internship\n- Keep GPA above 3.5\n- Ship the robotics arm demo\n" },
  { name: "routines.md", content: "# Routines\n\n- Best focus: 2–5pm\n- Sleeps ~1am, up ~9am\n- Skips 8am blocks\n" },
  { name: "writingstyle.md", content: "# Writing style\n\nCasual but polite. Short paragraphs. Signs off \"Best, Maya\".\n" },
  { name: "people.md", content: "# People\n\n- **Prof. Lee**: advisor, CS 201\n- **Jordan**: TA, MATH 220\n" },
];
