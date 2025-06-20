#!/usr/bin/env node

// bin/ft.js

const CLI = require('../src/cli');

let isExiting = false;

async function main() {
  try {
    const cli = new CLI();
    await cli.run(process.argv);
  } catch (error) {
    if (!isExiting) {
      console.error('Fatal error:', error.message);
      safeExit(1);
    }
  }
}

/**
 * Safe exit that prevents multiple exit calls
 * @param {number} code - Exit code
 */
function safeExit(code) {
  if (isExiting) return;
  isExiting = true;
  process.exit(code);
}

/**
 * Safe error handler that prevents recursion
 * @param {string} type - Error type
 * @param {Error} error - Error object
 */
function handleTopLevelError(type, error) {
  if (isExiting) return;
  
  try {
    console.error(`${type}:`, error.message || error);
  } catch (logError) {
    // If even logging fails, just exit
  }
  
  safeExit(1);
}

// Handle only truly uncaught errors (CLI handles its own errors)
process.on('uncaughtException', (error) => {
  handleTopLevelError('Uncaught exception in main process', error);
});

process.on('unhandledRejection', (reason) => {
  handleTopLevelError('Unhandled promise rejection in main process', reason);
});

main().catch((error) => {
  handleTopLevelError('Main function failed', error);
});