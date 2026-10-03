// core/taskModel.js

// Priority ranking helper
export function priorityRank(priority) {
  const map = {
    high: 1,
    medium: 2,
    low: 3
  };
  return map[priority] ?? 2; // default medium
}

// Difficulty ranking helper
export function difficultyRank(difficulty) {
  const map = {
    easy: 1,
    medium: 2,
    hard: 3
  };
  return map[difficulty] ?? 2; // default medium
}

// Main Task class
export class Task {
  constructor({
    id = crypto.randomUUID(),
    title,
    duration = 60,          // minutes
    deadline = null,        // Date object or null
    priority = "medium",    // low | medium | high
    energy = "medium",      // low | medium | high
    tags = [],
    difficulty = "medium",  // easy | medium | hard
    flexible = true,        // can this task move?
    scheduledStart = null,  // Date object
    scheduledEnd = null     // Date object
  }) {
    this.id = id;
    this.title = title;
    this.duration = duration;
    this.deadline = deadline ? new Date(deadline) : null;
    this.priority = priority;
    this.energy = energy;
    this.tags = tags;
    this.difficulty = difficulty;
    this.flexible = flexible;
    this.scheduledStart = scheduledStart;
    this.scheduledEnd = scheduledEnd;
  }

  // Helper: convert task to plain object (for saving to localStorage)
  toJSON() {
    return {
