const catchAsync = require('../utils/catchAsync');
const mongoHelper = require('../models/customdb');
// const redisService = require('../services/redis.service');
// Create a new table
exports.createTable = catchAsync(async (req, res) => {
    const tableData = {
        tableTypeId: req.body.tableTypeId,
        maxPlayers: req?.body?.maxPlayers,
        currentPlayers: [],
        gameRoundsCompleted: 0,
        dealerPosition: null,
        currentTurnPosition: null,
        smallBlindPosition: null,
        bigBlindPosition: null,
        isPreCreated: false,
        status: req?.body?.status,
        blockchainAddress: null,
        tableBlockchainId: null,
    };
    const table = await mongoHelper.create(
        mongoHelper.COLLECTIONS.TABLES,
        tableData,
        mongoHelper.MODELS.TABLE
    );
    // await redisService.clearTablesList();
    res.status(201).json({
        success: true,
        message: 'Table created successfully',
        data: table.data
    });
});

// Get all tables with pagination and filtering
exports.getAllTables = catchAsync(async (req, res) => {
    const {
        page = 1,
        limit = 10,
        status,
        maxPlayers,
        tableTypeId
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const cacheKey = `tables:all:${status || 'all'}:${maxPlayers || 'all'}:${tableTypeId || 'all'}:${pageNum}:${limitNum}`;

    // const cached = await redisService.getTablesList(cacheKey);
    // console.log(cached , "cache Found")
    // if (cached) {
    //     return res.status(200).json(cached);
    // }

    const tablesResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.TABLES);

    if (!tablesResult.success) {
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve tables'
        });
    }

    let tables = tablesResult.data || [];

    for (let table of tables) {
        if (table.tableTypeId) {
            const typeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, table.tableTypeId);
            if (typeResult.success) table.tableTypeId = typeResult.data;
        }
        if (table.gameState) {
            const stateResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.GAME_STATES, table.gameState);
            if (stateResult.success) table.gameState = stateResult.data;
        }
        if (table.currentPlayers && table.currentPlayers.length > 0) {
            const players = [];
            for (let playerId of table.currentPlayers) {
                const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PLAYERS, playerId);
                if (playerResult.success) players.push(playerResult.data);
            }
            table.currentPlayers = players;
        }
    }
    
    if (status) tables = tables.filter(t => t.status === status);
    if (maxPlayers) tables = tables.filter(t => t.maxPlayers === parseInt(maxPlayers));
    if (tableTypeId) tables = tables.filter(t => t.tableTypeId?._id === tableTypeId);

    tables.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const total = tables.length;
    const totalPages = Math.ceil(total / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const paginatedTables = tables.slice(startIndex, startIndex + limitNum);

    const response = {
        success: true,
        message: 'Tables retrieved successfully',
        data: paginatedTables,
        totalDocs: total,
        limit: limitNum,
        totalPages,
        page: pageNum,
        pagingCounter: startIndex + 1,
        hasPrevPage: pageNum > 1,
        hasNextPage: pageNum < totalPages,
        prevPage: pageNum > 1 ? pageNum - 1 : null,
        nextPage: pageNum < totalPages ? pageNum + 1 : null
    };

    // await redisService.cacheTablesList(cacheKey, response);
    res.status(200).json(response);
});

// Update table by ID
exports.updateTable = catchAsync(async (req, res) => {
    const table = await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.TABLES,
        req.params.id,
        req.body,
        mongoHelper.MODELS.TABLE
    );

    if (!table.success) {
        return res.status(404).json({
            success: false,
            message: 'Table not found'
        });
    }

    res.status(200).json({
        success: true,
        message: 'Table updated successfully',
        data: table.data
    });

});

// Delete table by ID
exports.deleteTable = catchAsync(async (req, res) => {
    const table = await mongoHelper.deleteById(mongoHelper.COLLECTIONS.TABLES, req.params.id);

    if (!table.success) {
        return res.status(404).json({
            success: false,
            message: 'Table not found'
        });
    }

    // await redisService.clearTablesList();
    res.status(200).json({
        success: true,
        message: 'Table deleted successfully'
    });

});

// Get available tables for table pool
exports.getAvailableTables = catchAsync(async (req, res) => {
    const { maxPlayers, tableTypeId } = req.query;

    const filter = {
        status: 'available',
        isPreCreated: true
    };

    if (maxPlayers) filter.maxPlayers = parseInt(maxPlayers);
    if (tableTypeId) filter.tableTypeId = tableTypeId;

    const tablesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, filter);
    const tables = tablesResult.success ? tablesResult.data : [];
    
    // Populate tableTypeId for each table
    for (let table of tables) {
        if (table.tableTypeId) {
            const typeResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLE_TYPES, table.tableTypeId);
            if (typeResult.success) table.tableTypeId = typeResult.data;
        }
    }
    tables.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    res.status(200).json({
        success: true,
        message: 'Available tables retrieved successfully',
        data: tables
    });
});

exports.findOrCreateTableType = catchAsync(async (req, res) => {
    const { tableName, minBuyIn, maxBuyIn, maxSeats, status = 'active' } = req.body;

    // Validate required fields
    if (!tableName || !minBuyIn || !maxBuyIn || !maxSeats) {
        return res.status(400).json({
            success: false,
            message: 'tableName, minBuyIn, maxBuyIn, and maxSeats are required'
        });
    }

    if (maxBuyIn <= minBuyIn) {
        return res.status(400).json({
            success: false,
            message: 'maxBuyIn must be greater than minBuyIn'
        });
    }

    // Calculate blinds manually
    const calculateBlinds = (minBuyIn) => {
        const BLIND_STRUCTURES = [
            { minBuyIn: 0, blinds: [0.01, 0.02] },
            { minBuyIn: 1, blinds: [0.02, 0.05] },
            { minBuyIn: 2, blinds: [0.05, 0.10] },
            { minBuyIn: 5, blinds: [0.10, 0.25] },
            { minBuyIn: 10, blinds: [0.25, 0.50] },
            { minBuyIn: 20, blinds: [0.50, 1] },
            { minBuyIn: 50, blinds: [1, 2] },
            { minBuyIn: 100, blinds: [2, 5] },
            { minBuyIn: 200, blinds: [5, 10] },
            { minBuyIn: 500, blinds: [10, 25] },
            { minBuyIn: 1000, blinds: [25, 50] },
            { minBuyIn: 2000, blinds: [50, 100] },
            { minBuyIn: 5000, blinds: [100, 200] },
            { minBuyIn: 10000, blinds: [200, 500] },
        ];

        const sortedStructures = [...BLIND_STRUCTURES].sort((a, b) => b.minBuyIn - a.minBuyIn);
        const structure = sortedStructures.find(s => minBuyIn >= s.minBuyIn) ||
            BLIND_STRUCTURES[BLIND_STRUCTURES.length - 1];

        return {
            smallBlind: structure.blinds[0],
            bigBlind: structure.blinds[1]
        };
    };

    const { smallBlind, bigBlind } = calculateBlinds(minBuyIn);

    // Check for existing table type
    const allTypesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLE_TYPES, {createSpareTables: req.body.createSpareTables || false});

    const existingTableType = allTypesResult.success ? allTypesResult.data.find(t => {
        return t.tableName === tableName.trim() ||
            (Number(t.minBuyIn) === Number(minBuyIn) &&
            Number(t.maxBuyIn) === Number(maxBuyIn) &&
            Number(t.maxSeats) === Number(maxSeats));
    }) : null;

    if (existingTableType) {
        if (existingTableType.tableName === tableName.trim()) {
            return res.status(200).json({
                success: true,
                message: 'Table type with this name already exists',
                data: existingTableType
            });
        } else {
            return res.status(200).json({
                success: true,
                message: 'Table type with same minBuyIn, maxBuyIn, and maxSeats already exists',
                data: existingTableType
            });
        }
    }

    // Pass calculated blinds to mongoHelper
    const tableTypeData = {
        tableName: tableName.trim(),
        minBuyIn,
        maxBuyIn,
        maxSeats,
        status,
        smallBlind,
        bigBlind,
        createSpareTables: req.body.createSpareTables || false
    };

    const tableType = await mongoHelper.create(
        mongoHelper.COLLECTIONS.TABLE_TYPES,
        tableTypeData,
        mongoHelper.MODELS.TABLE_TYPE
    );

    res.status(201).json({
        success: true,
        message: 'Table type created successfully',
        data: tableType?.data
    });
});

exports.getTableById = catchAsync(async (req, res) => {
    const id = req.params.id || req.query.id;
    console.log("hello:", id)
    const tableResult = await mongoHelper.findByIdWithPopulate(
        mongoHelper.COLLECTIONS.TABLES,
        id,
        [
            { path: 'tableTypeId', collection: mongoHelper.COLLECTIONS.TABLE_TYPES, select: 'tableName  minBuyIn maxBuyIn smallBlind bigBlind ' },
            { path: 'currentPlayers', collection: mongoHelper.COLLECTIONS.PLAYERS, select: 'user seatPosition' },
            { path: 'gameState', collection: mongoHelper.COLLECTIONS.GAME_STATES, select: 'boardCards' }
        ]
    );

    if (!tableResult.success || !tableResult.data) {
        return res.status(404).json({
            success: false,
            message: 'Table not found'
        });
    }

    res.status(200).json({
        success: true,
        message: 'Table retrieved successfully',
        data: tableResult.data
    });
});