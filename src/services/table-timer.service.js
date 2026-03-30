// src/services/table-timer.service.js

const mongoHelper = require('../models/customdb');
const { emitSuccess, emitError } = require('../websocket/socket-emitter');

class TableTimerService {
  constructor() {
    this.activeTimers = new Map(); // tableId -> timer info
    this.io = null; // Will be set by the orchestrator
  }
  
  setIO(io) {
    this.io = io;
  }
  
  /**
   * Start table timer for timed private tables
   */
  async startTableTimer(tableId, timeLimit) {
    try {
      if (!timeLimit || timeLimit <= 0) {
        console.log(`⏰ [TIMER] Table ${tableId} has no time limit, skipping timer`);
        return;
      }
      
      console.log(`⏰ [TIMER] Starting ${timeLimit} minute timer for table ${tableId}`);
      
      const startTime = Date.now();
      const endTime = startTime + (timeLimit * 60 * 1000); // Convert minutes to milliseconds
      
      // Store timer info
      this.activeTimers.set(tableId, {
        startTime,
        endTime,
        timeLimit,
        warningsSent: {
          fiveMinute: false,
          twoMinute: false,
          finalRound: false
        }
      });
      
      // Set up the main timer check interval (every 30 seconds)
      const timerInterval = setInterval(() => {
        this.checkTableTimer(tableId);
      }, 30000);
      
      // Store interval reference
      this.activeTimers.get(tableId).interval = timerInterval;
      
      // Emit timer started event
      if (this.io) {\n        emitSuccess(this.io.to(tableId), 'tableTimerStarted', {\n          timeLimit,\n          endTime,\n          message: `Table will end in ${timeLimit} minutes`\n        }, `Table timer started: ${timeLimit} minutes`);\n      }\n      \n    } catch (error) {\n      console.error(`❌ [TIMER] Error starting timer for table ${tableId}:`, error);\n    }\n  }\n  \n  /**\n   * Check table timer and send warnings\n   */\n  async checkTableTimer(tableId) {\n    try {\n      const timerInfo = this.activeTimers.get(tableId);\n      if (!timerInfo) return;\n      \n      const now = Date.now();\n      const timeRemaining = timerInfo.endTime - now;\n      const minutesRemaining = Math.floor(timeRemaining / (60 * 1000));\n      \n      console.log(`⏰ [TIMER CHECK] Table ${tableId}: ${minutesRemaining} minutes remaining`);\n      \n      // Check if time has expired\n      if (timeRemaining <= 0) {\n        await this.handleTimeExpired(tableId);\n        return;\n      }\n      \n      // Send warnings\n      if (minutesRemaining <= 5 && !timerInfo.warningsSent.fiveMinute) {\n        await this.sendTimeWarning(tableId, 5, 'Table will end in 5 minutes!');\n        timerInfo.warningsSent.fiveMinute = true;\n      }\n      \n      if (minutesRemaining <= 2 && !timerInfo.warningsSent.twoMinute) {\n        await this.sendTimeWarning(tableId, 2, 'Table will end in 2 minutes!');\n        timerInfo.warningsSent.twoMinute = true;\n      }\n      \n      // Check if we should mark this as the final round\n      if (minutesRemaining <= 1 && !timerInfo.warningsSent.finalRound) {\n        await this.markFinalRound(tableId);\n        timerInfo.warningsSent.finalRound = true;\n      }\n      \n    } catch (error) {\n      console.error(`❌ [TIMER] Error checking timer for table ${tableId}:`, error);\n    }\n  }\n  \n  /**\n   * Handle when time expires\n   */\n  async handleTimeExpired(tableId) {\n    try {\n      console.log(`⏰ [TIME EXPIRED] Table ${tableId} time limit reached`);\n      \n      // Check if game is currently in progress\n      const gameStateManager = require('../state/game-state');\n      const gameState = await gameStateManager.getGame(tableId);\n      \n      if (gameState && gameState.phase !== 'COMPLETED') {\n        console.log(`🎮 [FINAL ROUND] Table ${tableId} will end after current hand`);\n        \n        // Mark the game to end after current hand\n        gameState.timeExpired = true;\n        gameState.finalRound = true;\n        await gameStateManager.updateGame(tableId, gameState);\n        \n        // Notify players\n        if (this.io) {\n          emitSuccess(this.io.to(tableId), 'timeExpired', {\n            message: 'Time limit reached! Game will end after this hand.',\n            finalRound: true\n          }, 'Time limit reached - final round!');\n        }\n      } else {\n        console.log(`🏁 [GAME ENDED] Table ${tableId} ended due to time limit`);\n        \n        // Game already completed or no active game\n        if (this.io) {\n          emitSuccess(this.io.to(tableId), 'gameEndedByTime', {\n            reason: 'TIME_LIMIT',\n            message: 'Game ended due to time limit'\n          }, 'Game ended by time limit');\n        }\n      }\n      \n      // Clean up timer\n      this.clearTableTimer(tableId);\n      \n    } catch (error) {\n      console.error(`❌ [TIMER] Error handling time expiry for table ${tableId}:`, error);\n    }\n  }\n  \n  /**\n   * Mark current round as final round\n   */\n  async markFinalRound(tableId) {\n    try {\n      const gameStateManager = require('../state/game-state');\n      const gameState = await gameStateManager.getGame(tableId);\n      \n      if (gameState && gameState.phase !== 'COMPLETED') {\n        gameState.finalRound = true;\n        await gameStateManager.updateGame(tableId, gameState);\n        \n        console.log(`🏁 [FINAL ROUND] Table ${tableId} marked as final round`);\n        \n        if (this.io) {\n          emitSuccess(this.io.to(tableId), 'finalRound', {\n            message: 'This is the final round! Game will end after this hand.',\n            timeRemaining: 'Less than 1 minute'\n          }, 'Final round - game ending soon!');\n        }\n      }\n    } catch (error) {\n      console.error(`❌ [TIMER] Error marking final round for table ${tableId}:`, error);\n    }\n  }\n  \n  /**\n   * Send time warning to players\n   */\n  async sendTimeWarning(tableId, minutes, message) {\n    try {\n      console.log(`⚠️ [TIME WARNING] Table ${tableId}: ${message}`);\n      \n      if (this.io) {\n        emitSuccess(this.io.to(tableId), 'timeWarning', {\n          minutesRemaining: minutes,\n          message,\n          urgent: minutes <= 2\n        }, message);\n      }\n    } catch (error) {\n      console.error(`❌ [TIMER] Error sending warning for table ${tableId}:`, error);\n    }\n  }\n  \n  /**\n   * Clear table timer\n   */\n  clearTableTimer(tableId) {\n    const timerInfo = this.activeTimers.get(tableId);\n    if (timerInfo) {\n      if (timerInfo.interval) {\n        clearInterval(timerInfo.interval);\n      }\n      this.activeTimers.delete(tableId);\n      console.log(`🗑️ [TIMER] Cleared timer for table ${tableId}`);\n    }\n  }\n  \n  /**\n   * Get remaining time for a table\n   */\n  getRemainingTime(tableId) {\n    const timerInfo = this.activeTimers.get(tableId);\n    if (!timerInfo) return null;\n    \n    const now = Date.now();\n    const timeRemaining = Math.max(0, timerInfo.endTime - now);\n    const minutesRemaining = Math.floor(timeRemaining / (60 * 1000));\n    const secondsRemaining = Math.floor((timeRemaining % (60 * 1000)) / 1000);\n    \n    return {\n      totalMs: timeRemaining,\n      minutes: minutesRemaining,\n      seconds: secondsRemaining,\n      expired: timeRemaining <= 0\n    };\n  }\n  \n  /**\n   * Check if table should end after current hand\n   */\n  async shouldEndAfterHand(tableId) {\n    try {\n      const gameStateManager = require('../state/game-state');\n      const gameState = await gameStateManager.getGame(tableId);\n      \n      return gameState && (gameState.timeExpired || gameState.finalRound);\n    } catch (error) {\n      console.error(`❌ [TIMER] Error checking if table should end:`, error);\n      return false;\n    }\n  }\n  \n  /**\n   * Get all active timers (for debugging)\n   */\n  getActiveTimers() {\n    const timers = {};\n    for (const [tableId, timerInfo] of this.activeTimers) {\n      const remaining = this.getRemainingTime(tableId);\n      timers[tableId] = {\n        timeLimit: timerInfo.timeLimit,\n        startTime: new Date(timerInfo.startTime),\n        endTime: new Date(timerInfo.endTime),\n        remaining\n      };\n    }\n    return timers;\n  }\n  \n  /**\n   * Initialize timer for existing private table (on server restart)\n   */\n  async initializeExistingTableTimer(tableId) {\n    try {\n      // Get table configuration\n      const tableConfigService = require('./table-configuration.service');\n      const config = await tableConfigService.getTableConfiguration(tableId);\n      \n      if (!config || config.duration.type !== 'TIMED' || !config.duration.timeLimit) {\n        return; // Not a timed table\n      }\n      \n      // Get table start time\n      const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);\n      if (!tableResult.success || !tableResult.data) {\n        return;\n      }\n      \n      const table = tableResult.data;\n      if (!table.gameStartedAt) {\n        return; // Game hasn't started yet\n      }\n      \n      const gameStartTime = new Date(table.gameStartedAt).getTime();\n      const timeLimit = config.duration.timeLimit; // in minutes\n      const endTime = gameStartTime + (timeLimit * 60 * 1000);\n      const now = Date.now();\n      \n      if (now >= endTime) {\n        // Time already expired\n        await this.handleTimeExpired(tableId);\n      } else {\n        // Start timer with remaining time\n        const remainingMinutes = Math.ceil((endTime - now) / (60 * 1000));\n        await this.startTableTimer(tableId, remainingMinutes);\n      }\n      \n    } catch (error) {\n      console.error(`❌ [TIMER] Error initializing existing timer for table ${tableId}:`, error);\n    }\n  }\n}\n\nmodule.exports = new TableTimerService();