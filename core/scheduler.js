// core/scheduler.js

import { priorityRank, difficultyRank } from "./taskModel.js";

/**
 * Get all free time blocks between dayStart and dayEnd
 * based on already scheduled tasks.
 */
export function getFreeBlocks(existingTasks, dayStart, dayEnd) {
  const blocks = [];
  let cursor = new Date(dayStart);

  // Only consider tasks that already have scheduled times
  const sorted = existingTasks
    .filter(t => t.scheduledStart && t.scheduledEnd)
    .sort((a, b) => a.scheduledStart - b.scheduledStart);

  for (const task of sorted) {
    if (cursor < task.scheduledStart) {
      blocks.push({
        start: new Date(cursor),
        end: new Date(task.scheduledStart)
      });
    }
    cursor = new Date(task.scheduledEnd);
  }

  // Remaining time after last task
  if (cursor < dayEnd) {
    blocks.push({ start: cursor, end: dayEnd });
  }

  return blocks;
}

/**
 * Find the optimal slot for a task inside the free blocks.
 */
export function findOptimalSlot(task, freeBlocks) {
  for (const block of freeBlocks) {
    const blockMinutes = (block.end - block.start) / (1000 * 60);

    if (blockMinutes >= task.duration) {
      return {
        start: new Date(block.start),
        end: new Date(block.start.getTime() + task.duration * 60000)
      };
    }
  }

  return null; // No available slot
}

/**
 * Schedule a single task into the earliest available free block.
 */
export function scheduleTask(task, existingTasks, dayStart, dayEnd) {
  const freeBlocks = get
