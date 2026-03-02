// src/game/away-manager.service.js

const gameStateManager = require('../state/game-state');
const tableManager = require('../table/table-manager.service');

class AwayManager {
  async setAway(tableId, userId) {
    const gameState =
      await gameStateManager.getGame(tableId);

    const player =
      gameState.players.find(p => p.id === userId);

    if (!player) return;

    player.isAway = true;
    player.awaySkips = 0;

    await gameStateManager.updateGame(tableId, gameState);
  }

async setBack(tableId , userId)
{
  const gameState = await gameStateManager.getGame(tableId);
  const player = gameState.players.find(p => p.id === userId);

  if (!player) return;
  player.isAway = false;
  player.awaySkips = 0;
  
  await gameStateManager.updateGame(tableId, gameState);
}

  async handleAwayTurn(tableId, player, gameState) {
    if (!player.isAway) return false;

    player.awaySkips += 1;

    if (player.awaySkips >= 10) {
      player.status = 'FOLDED';
      player.disconnected = true;

      await tableManager.removePlayer(tableId, player.id);

      return true;
    }

    const validation =
      require('../engine/poker-engine')
        .validateAction(player, gameState);

    if (validation.options.includes('check')) {
      return { type: 'check' };
    }

    return { type: 'fold' };
  }
}

module.exports = new AwayManager();