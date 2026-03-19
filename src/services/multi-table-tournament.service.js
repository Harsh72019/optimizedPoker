const { Tournament, TournamentPlayer } = require('../models/tournament.model');

class MultiTableTournamentService {
  
  /**
   * Distribute players across multiple tables
   * "divide all the players equally between the tables"
   */
  distributePlayersAcrossTables(totalPlayers, maxPlayersPerTable = 9) {
    if (totalPlayers <= maxPlayersPerTable) {
      return [totalPlayers];
    }
    
    const numTables = Math.ceil(totalPlayers / maxPlayersPerTable);
    const basePlayersPerTable = Math.floor(totalPlayers / numTables);
    let remainder = totalPlayers % numTables;
    
    const tableSizes = [];
    for (let i = 0; i < numTables; i++) {
      tableSizes.push(basePlayersPerTable + (remainder > 0 ? 1 : 0));
      remainder--;
    }
    
    return tableSizes;
  }
  
  /**
   * Create tournament tables with balanced player distribution
   */
  async createTournamentTables(tournamentId, players) {
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      throw new Error('Tournament not found');
    }
    
    const maxPlayersPerTable = tournament.maxPlayersPerTable || 9;
    const tableSizes = this.distributePlayersAcrossTables(players.length, maxPlayersPerTable);
    
    const tables = [];
    let playerIndex = 0;
    
    for (let i = 0; i < tableSizes.length; i++) {
      const tableSize = tableSizes[i];
      const tablePlayers = players.slice(playerIndex, playerIndex + tableSize);
      
      // Create table configuration
      const tableConfig = {
        tournamentId,
        tableNumber: i + 1,
        maxPlayers: tableSize,
        players: tablePlayers.map((player, seatIndex) => ({
          playerId: player._id,
          userId: player.user,
          seatPosition: seatIndex + 1,
          chips: tournament.startingChips,
          status: 'active'
        })),
        blindLevel: tournament.currentLevel,
        status: 'active'
      };
      
      tables.push(tableConfig);
      playerIndex += tableSize;
    }
    
    console.log(`🎯 Created ${tables.length} tables for tournament ${tournamentId}:`, 
      tableSizes.map((size, i) => `Table ${i + 1}: ${size} players`).join(', ')
    );
    
    return tables;
  }
  
  /**
   * Rebalance tables when players are eliminated
   */
  async rebalanceTables(tournamentId) {
    const tournament = await Tournament.findById(tournamentId)
      .populate('players')
      .populate('activeTables');
    
    if (!tournament) {
      throw new Error('Tournament not found');
    }
    
    // Get active players across all tables
    const activePlayers = await TournamentPlayer.find({
      tournament: tournamentId,
      status: { $in: ['active', 'small-blind', 'big-blind', 'all-in'] }
    });
    
    if (activePlayers.length <= tournament.maxPlayersPerTable) {
      // Move to final table
      return await this.createFinalTable(tournamentId, activePlayers);
    }
    
    // Calculate optimal table distribution
    const optimalSizes = this.distributePlayersAcrossTables(
      activePlayers.length, 
      tournament.maxPlayersPerTable
    );
    
    // Check if rebalancing is needed
    const currentTables = tournament.activeTables;
    const needsRebalancing = this.shouldRebalance(currentTables, optimalSizes);
    
    if (needsRebalancing) {
      console.log(`⚖️ Rebalancing tournament ${tournamentId}: ${activePlayers.length} players across ${optimalSizes.length} tables`);
      return await this.executeRebalancing(tournamentId, activePlayers, optimalSizes);
    }
    
    return { rebalanced: false, reason: 'No rebalancing needed' };
  }
  
  /**
   * Check if tables need rebalancing
   */
  shouldRebalance(currentTables, optimalSizes) {
    if (currentTables.length !== optimalSizes.length) {
      return true;
    }
    
    // Check if any table has significantly different player count
    for (let i = 0; i < currentTables.length; i++) {
      const currentSize = currentTables[i].players.filter(p => p.status === 'active').length;
      const optimalSize = optimalSizes[i];
      
      if (Math.abs(currentSize - optimalSize) > 1) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Execute table rebalancing
   */
  async executeRebalancing(tournamentId, activePlayers, optimalSizes) {
    // Shuffle players to ensure fair redistribution
    const shuffledPlayers = this.shuffleArray([...activePlayers]);
    
    const newTables = [];
    let playerIndex = 0;
    
    for (let i = 0; i < optimalSizes.length; i++) {
      const tableSize = optimalSizes[i];
      const tablePlayers = shuffledPlayers.slice(playerIndex, playerIndex + tableSize);
      
      const tableConfig = {
        tournamentId,
        tableNumber: i + 1,
        maxPlayers: tableSize,
        players: tablePlayers.map((player, seatIndex) => ({
          playerId: player._id,
          userId: player.user,
          seatPosition: seatIndex + 1,
          chips: player.chipsInPlay,
          status: player.status
        })),
        status: 'active'
      };
      
      newTables.push(tableConfig);
      playerIndex += tableSize;
    }
    
    // Update tournament with new table configuration
    const tournament = await Tournament.findById(tournamentId);
    tournament.activeTables = newTables;
    await tournament.save();
    
    console.log(`✅ Rebalanced tournament ${tournamentId}: ${newTables.length} tables`);
    
    return {
      rebalanced: true,
      newTableCount: newTables.length,
      tableSizes: optimalSizes,
      tables: newTables
    };
  }
  
  /**
   * Create final table when players <= maxPlayersPerTable
   */
  async createFinalTable(tournamentId, finalPlayers) {
    const tournament = await Tournament.findById(tournamentId);
    
    // Mark final table formation
    tournament.finalTableFormed = true;
    tournament.finalTableFormedAt = new Date();
    
    // Create final table stats
    const chipLeader = finalPlayers.reduce((leader, player) => 
      player.chipsInPlay > leader.chipsInPlay ? player : leader
    );
    
    tournament.finalTableStats = {
      playersAtFinalTable: finalPlayers.length,
      chipLeader: {
        playerId: chipLeader._id,
        userId: chipLeader.user,
        chips: chipLeader.chipsInPlay
      },
      playerDetails: finalPlayers.map(player => ({
        playerId: player._id,
        userId: player.user,
        currentChips: player.chipsInPlay,
        bigBlinds: Math.floor(player.chipsInPlay / tournament.currentLevel.bigBlind)
      })),
      startingChipCounts: new Map(
        finalPlayers.map(player => [player._id.toString(), player.chipsInPlay])
      )
    };
    
    // Create single final table
    const finalTable = {
      tournamentId,
      tableNumber: 1,
      maxPlayers: finalPlayers.length,
      players: finalPlayers.map((player, seatIndex) => ({
        playerId: player._id,
        userId: player.user,
        seatPosition: seatIndex + 1,
        chips: player.chipsInPlay,
        status: player.status
      })),
      isFinalTable: true,
      status: 'active'
    };
    
    tournament.activeTables = [finalTable];
    await tournament.save();
    
    console.log(`🏆 Final table created for tournament ${tournamentId}: ${finalPlayers.length} players`);
    
    return {
      finalTableFormed: true,
      finalTable,
      chipLeader: tournament.finalTableStats.chipLeader,
      playersRemaining: finalPlayers.length
    };
  }
  
  /**
   * Handle player elimination and trigger rebalancing if needed
   */
  async onPlayerEliminated(tournamentId, eliminatedPlayerId) {
    const eliminatedPlayer = await TournamentPlayer.findById(eliminatedPlayerId);
    if (!eliminatedPlayer) {
      throw new Error('Player not found');
    }
    
    // Mark player as eliminated
    eliminatedPlayer.status = 'eliminated';
    eliminatedPlayer.eliminatedAt = new Date();
    await eliminatedPlayer.save();
    
    console.log(`❌ Player eliminated from tournament ${tournamentId}`);
    
    // Check if rebalancing is needed
    const rebalanceResult = await this.rebalanceTables(tournamentId);
    
    return {
      playerEliminated: true,
      eliminatedAt: eliminatedPlayer.eliminatedAt,
      rebalancing: rebalanceResult
    };
  }
  
  /**
   * Shuffle array utility
   */
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  
  /**
   * Get tournament table status
   */
  async getTournamentTableStatus(tournamentId) {
    const tournament = await Tournament.findById(tournamentId)
      .populate('players');
    
    if (!tournament) {
      throw new Error('Tournament not found');
    }
    
    const activePlayers = await TournamentPlayer.find({
      tournament: tournamentId,
      status: { $in: ['active', 'small-blind', 'big-blind', 'all-in'] }
    });
    
    const eliminatedPlayers = await TournamentPlayer.find({
      tournament: tournamentId,
      status: 'eliminated'
    });
    
    return {
      tournamentId,
      totalRegistered: tournament.players.length,
      activePlayers: activePlayers.length,
      eliminatedPlayers: eliminatedPlayers.length,
      activeTables: tournament.activeTables?.length || 0,
      finalTableFormed: tournament.finalTableFormed,
      status: tournament.status
    };
  }
}

module.exports = new MultiTableTournamentService();