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
      const endTime = startTime + timeLimit * 60 * 1000;

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

      const timerInterval = setInterval(() => {
        this.checkTableTimer(tableId);
      }, 30000);

      this.activeTimers.get(tableId).interval = timerInterval;

      // Only emit if IO is available and has the join method
      if (this.io && typeof this.io.to === 'function') {
        try {
          emitSuccess(
            this.io.to(tableId),
            'tableTimerStarted',
            {
              timeLimit,
              endTime,
              message: `Table will end in ${timeLimit} minutes`
            },
            `Table timer started: ${timeLimit} minutes`
          );
        } catch (emitError) {
          console.warn(`⚠️ [TIMER] Could not emit timer start event: ${emitError.message}`);
        }
      } else {
        console.log(`⚠️ [TIMER] IO not available, timer started silently for table ${tableId}`);
      }
    } catch (error) {
      console.error(`❌ [TIMER] Error starting timer for table ${tableId}:`, error);
    }
  }

  /**
   * Check table timer and send warnings
   */
  async checkTableTimer(tableId) {
    try {
      const timerInfo = this.activeTimers.get(tableId);
      if (!timerInfo) return;

      const now = Date.now();
      const timeRemaining = timerInfo.endTime - now;
      const minutesRemaining = Math.floor(timeRemaining / (60 * 1000));

      console.log(`⏰ [TIMER CHECK] Table ${tableId}: ${minutesRemaining} minutes remaining`);

      if (timeRemaining <= 0) {
        await this.handleTimeExpired(tableId);
        return;
      }

      if (minutesRemaining <= 5 && !timerInfo.warningsSent.fiveMinute) {
        await this.sendTimeWarning(tableId, 5, 'Table will end in 5 minutes!');
        timerInfo.warningsSent.fiveMinute = true;
      }

      if (minutesRemaining <= 2 && !timerInfo.warningsSent.twoMinute) {
        await this.sendTimeWarning(tableId, 2, 'Table will end in 2 minutes!');
        timerInfo.warningsSent.twoMinute = true;
      }

      if (minutesRemaining <= 1 && !timerInfo.warningsSent.finalRound) {
        await this.markFinalRound(tableId);
        timerInfo.warningsSent.finalRound = true;
      }
    } catch (error) {
      console.error(`❌ [TIMER] Error checking timer for table ${tableId}:`, error);
    }
  }

  /**
   * Handle when time expires
   */
  async handleTimeExpired(tableId) {
    try {
      console.log(`⏰ [TIME EXPIRED] Table ${tableId} time limit reached`);

      const gameStateManager = require('../state/game-state');
      const gameState = await gameStateManager.getGame(tableId);

      if (gameState && gameState.phase !== 'COMPLETED') {
        console.log(`🎮 [FINAL ROUND] Table ${tableId} will end after current hand`);

        gameState.timeExpired = true;
        gameState.finalRound = true;

        await gameStateManager.updateGame(tableId, gameState);

        if (this.io && typeof this.io.to === 'function') {
          try {
            emitSuccess(
              this.io.to(tableId),
              'timeExpired',
              {
                message: 'Time limit reached! Game will end after this hand.',
                finalRound: true
              },
              'Time limit reached - final round!'
            );
          } catch (emitError) {
            console.warn(`⚠️ [TIMER] Could not emit time expired event: ${emitError.message}`);
          }
        }
      } else {
        console.log(`🏁 [GAME ENDED] Table ${tableId} ended due to time limit`);

        if (this.io && typeof this.io.to === 'function') {
          try {
            emitSuccess(
              this.io.to(tableId),
              'gameEndedByTime',
              {
                reason: 'TIME_LIMIT',
                message: 'Game ended due to time limit'
              },
              'Game ended by time limit'
            );
          } catch (emitError) {
            console.warn(`⚠️ [TIMER] Could not emit game ended event: ${emitError.message}`);
          }
        }
      }

      this.clearTableTimer(tableId);
    } catch (error) {
      console.error(`❌ [TIMER] Error handling time expiry for table ${tableId}:`, error);
    }
  }

  /**
   * Mark current round as final round
   */
  async markFinalRound(tableId) {
    try {
      const gameStateManager = require('../state/game-state');
      const gameState = await gameStateManager.getGame(tableId);

      if (gameState && gameState.phase !== 'COMPLETED') {
        gameState.finalRound = true;
        await gameStateManager.updateGame(tableId, gameState);

        console.log(`🏁 [FINAL ROUND] Table ${tableId} marked as final round`);

        if (this.io && typeof this.io.to === 'function') {
          try {
            emitSuccess(
              this.io.to(tableId),
              'finalRound',
              {
                message: 'This is the final round! Game will end after this hand.',
                timeRemaining: 'Less than 1 minute'
              },
              'Final round - game ending soon!'
            );
          } catch (emitError) {
            console.warn(`⚠️ [TIMER] Could not emit final round event: ${emitError.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`❌ [TIMER] Error marking final round for table ${tableId}:`, error);
    }
  }

  /**
   * Send time warning to players
   */
  async sendTimeWarning(tableId, minutes, message) {
    try {
      console.log(`⚠️ [TIME WARNING] Table ${tableId}: ${message}`);

      if (this.io && typeof this.io.to === 'function') {
        try {
          emitSuccess(
            this.io.to(tableId),
            'timeWarning',
            {
              minutesRemaining: minutes,
              message,
              urgent: minutes <= 2
            },
            message
          );
        } catch (emitError) {
          console.warn(`⚠️ [TIMER] Could not emit time warning: ${emitError.message}`);
        }
      }
    } catch (error) {
      console.error(`❌ [TIMER] Error sending warning for table ${tableId}:`, error);
    }
  }

  /**
   * Clear table timer
   */
  clearTableTimer(tableId) {
    const timerInfo = this.activeTimers.get(tableId);

    if (timerInfo) {
      if (timerInfo.interval) {
        clearInterval(timerInfo.interval);
      }

      this.activeTimers.delete(tableId);
      console.log(`🗑️ [TIMER] Cleared timer for table ${tableId}`);
    }
  }

  /**
   * Get remaining time for a table
   */
  getRemainingTime(tableId) {
    const timerInfo = this.activeTimers.get(tableId);
    if (!timerInfo) return null;

    const now = Date.now();
    const timeRemaining = Math.max(0, timerInfo.endTime - now);

    return {
      totalMs: timeRemaining,
      minutes: Math.floor(timeRemaining / (60 * 1000)),
      seconds: Math.floor((timeRemaining % (60 * 1000)) / 1000),
      expired: timeRemaining <= 0
    };
  }

  /**
   * Check if table should end after current hand
   */
  async shouldEndAfterHand(tableId) {
    try {
      const gameStateManager = require('../state/game-state');
      const gameState = await gameStateManager.getGame(tableId);

      return gameState && (gameState.timeExpired || gameState.finalRound);
    } catch (error) {
      console.error(`❌ [TIMER] Error checking if table should end:`, error);
      return false;
    }
  }

  /**
   * Get all active timers (for debugging)
   */
  getActiveTimers() {
    const timers = {};

    for (const [tableId, timerInfo] of this.activeTimers) {
      timers[tableId] = {
        timeLimit: timerInfo.timeLimit,
        startTime: new Date(timerInfo.startTime),
        endTime: new Date(timerInfo.endTime),
        remaining: this.getRemainingTime(tableId)
      };
    }

    return timers;
  }

  /**
   * Initialize timer for existing private table (on server restart)
   */
  async initializeExistingTableTimer(tableId) {
    try {
      const tableConfigService = require('./table-configuration.service');
      const config = await tableConfigService.getTableConfiguration(tableId);

      if (!config || config.duration.type !== 'TIMED' || !config.duration.timeLimit) {
        return;
      }

      const tableResult = await mongoHelper.findById(
        mongoHelper.COLLECTIONS.TABLES,
        tableId
      );

      if (!tableResult.success || !tableResult.data) return;

      const table = tableResult.data;
      if (!table.gameStartedAt) return;

      const gameStartTime = new Date(table.gameStartedAt).getTime();
      const endTime = gameStartTime + config.duration.timeLimit * 60 * 1000;
      const now = Date.now();

      if (now >= endTime) {
        await this.handleTimeExpired(tableId);
      } else {
        const remainingMinutes = Math.ceil((endTime - now) / (60 * 1000));
        await this.startTableTimer(tableId, remainingMinutes);
      }
    } catch (error) {
      console.error(
        `❌ [TIMER] Error initializing existing timer for table ${tableId}:`,
        error
      );
    }
  }
}

module.exports = new TableTimerService();