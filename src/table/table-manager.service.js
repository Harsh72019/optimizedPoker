// src/table/table-manager.service.js

const redisClient = require('../state/redis-client').getClient();

class TableManagerService {
    getTableKey(tableId) {
        return `table:${tableId}`;
    }

    async getTable(tableId) {
        const data = await redisClient.get(this.getTableKey(tableId));

        if (!data) {
            // Fetch table info to check if it's a private table
            const mongoHelper = require('../models/customdb');
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            
            // ✅ CRITICAL: Don't add bots to private tables
            const isPrivateTable = tableDoc.success && tableDoc.data && 
                                 (tableDoc.data.isPrivate || tableDoc.data.privateTableId);
            
            let table;
            
            if (isPrivateTable) {
                // Private table - no bot, empty players array
                console.log(`🔒 [TABLE MANAGER] Private table detected: ${tableId} - no bot added`);
                table = {
                    players: [],
                    dealerPosition: null,
                    status: 'IDLE',
                    tableBlockchainId: tableDoc?.data?.tableBlockchainId
                };
            } else {
                // Regular table - add bot as before
                let botChips = 10000; // Default fallback
                
                if (tableDoc.success && tableDoc.data && tableDoc.data.subTierId) {
                    const subTierDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, tableDoc.data.subTierId);
                    if (subTierDoc.success && subTierDoc.data) {
                        const bb = subTierDoc.data.tableConfig.bb;
                        botChips = parseFloat((bb * 100).toFixed(2)); // maxBuyIn = bb * 100
                    }
                }

                const botNames = ['MightyThor', 'SuperSimp', 'AlphaWrecker', 'DeltaForce'];
                const botUserId = `bot_${tableId}`;
                const bot = {
                    userId: botUserId,
                    username: botNames[Math.floor(Math.random() * botNames.length)],
                    seatPosition: 1,
                    chips: botChips,
                    isBot: true,
                    disconnected: false,
                };

                table = {
                    players: [bot],
                    dealerPosition: 1,
                    status: 'IDLE',
                    tableBlockchainId: tableDoc?.data?.tableBlockchainId
                };
                
                // Sync bot to MongoDB for regular tables only
                this.syncBotToMongo(tableId, botUserId).catch(err =>
                    console.error('Failed to sync bot to MongoDB:', err.message)
                );
            }

            await this.saveTable(tableId, table);
            return table;
        }

        return JSON.parse(data);
    }

    async syncBotToMongo(tableId, botUserId) {
        const mongoHelper = require('../models/customdb');
        const findResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
        
        if (findResult.success && findResult.data) {
            const table = findResult.data;
            
            // ✅ CRITICAL: Don't sync bots to private tables
            const isPrivateTable = table.isPrivate || table.privateTableId;
            if (isPrivateTable) {
                console.log(`🔒 [TABLE MANAGER] Skipping bot sync for private table: ${tableId}`);
                return;
            }
            
            const botExists = (table.currentPlayers || []).some(p => p.user?.toString() === botUserId);
            
            if (!botExists) {
                const updatedPlayers = [...(table.currentPlayers || []), { user: botUserId }];
                await mongoHelper.updateById(
                    mongoHelper.COLLECTIONS.TABLES,
                    tableId,
                    { currentPlayers: updatedPlayers }
                );
                console.log(`✅ Synced bot ${botUserId} to MongoDB TABLES`);
            }
        }
    }

    async saveTable(tableId, tableState) {
        await redisClient.set(
            this.getTableKey(tableId),
            JSON.stringify(tableState),
            'EX',
            3600
        );
    }

    async setStatus(tableId, status) {
        const table = await this.getTable(tableId);
        table.status = status;
        await this.saveTable(tableId, table);
    }

    async getStatus(tableId) {
        const table = await this.getTable(tableId);
        return table.status;
    }

    async seatPlayer(tableId, player) {
        const lockKey = `lock:table:${tableId}`;
        const lockValue = `${Date.now()}-${Math.random()}`;
        const lockTimeout = 5000; // 5 seconds
        
        // Acquire lock with timeout
        const lockAcquired = await redisClient.set(lockKey, lockValue, 'PX', lockTimeout, 'NX');
        
        if (!lockAcquired) {
            // Wait a bit and retry
            await new Promise(resolve => setTimeout(resolve, 100));
            return this.seatPlayer(tableId, player);
        }
        
        try {
            const table = await this.getTable(tableId);

            const existing = table.players.find(
                p => p.userId === player.userId
            );

            if (existing) {
                existing.disconnected = false;
                existing.socketId = player.socketId;
                existing.chips = player.chips; // Update chips on reconnect

                await this.saveTable(tableId, table);

                return { tableState: table, isReconnect: true };
            }

            const usedSeats = table.players.map(p => p.seatPosition);
            let seatPosition = 1;

            while (usedSeats.includes(seatPosition)) {
                seatPosition++;
            }

            table.players.push({
                userId: player.userId,
                username: player.username,
                seatPosition,
                chips: player.chips, // ✅ CRITICAL: Set chips field
                disconnected: false,
                socketId: player.socketId,
            });

            if (!table.dealerPosition) {
                table.dealerPosition = seatPosition;
            }

            await this.saveTable(tableId, table);

            return { tableState: table, isReconnect: false };
        } finally {
            // Release lock
            const script = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            await redisClient.eval(script, 1, lockKey, lockValue);
        }
    }

    async markDisconnected(tableId, userId) {
        const table = await this.getTable(tableId);

        const player = table.players.find(p => p.userId === userId);
        if (!player) return table;

        player.disconnected = true;

        await this.saveTable(tableId, table);
        return table;
    }

    async markReconnected(tableId, userId) {
        const table = await this.getTable(tableId);

        const player = table.players.find(p => p.userId === userId);
        if (!player) return table;

        player.disconnected = false;

        await this.saveTable(tableId, table);
        return table;
    }

    async rotateDealer(tableId) {
        const table = await this.getTable(tableId);

        // Only rotate among active players with chips
        const activePlayers = table.players
            .filter(p => p.chips > 0 && !p.disconnected)
            .sort((a, b) => a.seatPosition - b.seatPosition);

        if (activePlayers.length === 0) {
            table.dealerPosition = null;
            await this.saveTable(tableId, table);
            return null;
        }

        const currentIndex = activePlayers.findIndex(
            p => p.seatPosition === table.dealerPosition
        );

        let nextDealer;

        // If current dealer not found (busted/left), assign first
        if (currentIndex === -1) {
            nextDealer = activePlayers[0].seatPosition;
        } else {
            nextDealer =
                activePlayers[(currentIndex + 1) % activePlayers.length]
                    .seatPosition;
        }

        table.dealerPosition = nextDealer;

        await this.saveTable(tableId, table);

        return nextDealer;
    }

    async syncFromGameState(tableId, gameState) {
        if (!gameState) return null;

        const table = await this.getTable(tableId);
        const gamePlayers = new Map(gameState.players.map(player => [player.id, player]));

        table.players = table.players.map(player => {
            const gamePlayer = gamePlayers.get(player.userId);

            if (!gamePlayer) {
                return player;
            }

            return {
                ...player,
                chips: gamePlayer.chips,
            };
        });

        await this.saveTable(tableId, table);
        return table;
    }

    async removePlayer(tableId, userId) {
        const table = await this.getTable(tableId);

        table.players = table.players.filter(
            p => p.userId !== userId
        );

        if (table.players.length < 2) {
            table.dealerPosition = null;
            table.status = 'IDLE';
            await this.setStatus(tableId, 'IDLE');
        }

        console.log('Removed player', userId);

        await this.saveTable(tableId, table);

        return table;
    }

    async clearPlayers(tableId, status = 'COMPLETED') {
        const table = await this.getTable(tableId);

        table.players = [];
        table.dealerPosition = null;
        table.status = status;

        await this.saveTable(tableId, table);
        return table;
    }

    async getSeatedCount(tableId) {
        const table = await this.getTable(tableId);
        return table.players.length;
    }
}

module.exports = new TableManagerService();
