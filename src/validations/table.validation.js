const Joi = require('joi');
const { objectId } = require('./custom.validation');

const createTable = {
  body: Joi.object().keys({
    tableTypeId: Joi.string().optional(),
    maxPlayers: Joi.number().valid(5, 9).default(5),
    currentPlayers: Joi.array().items(Joi.string().custom(objectId)),
    playerJoiningTimes: Joi.array().items(Joi.object()),
    gameState: Joi.string().custom(objectId),
    dealerPosition: Joi.number().integer().min(0),
    smallBlindPosition: Joi.number().integer().min(0),
    bigBlindPosition: Joi.number().integer().min(0),
    currentTurnPosition: Joi.number().integer().min(0),
    gameRoundsCompleted: Joi.number().integer().min(0).default(0),
    blockchainAddress: Joi.string(),
    tableBlockchainId: Joi.string(),
    isPreCreated: Joi.boolean().default(false),
    status: Joi.string().valid('available', 'in-use', 'archived').default('available')
  })
};

const getTables = {
  query: Joi.object().keys({
    status: Joi.string().valid('available', 'in-use', 'archived'),
    maxPlayers: Joi.number().valid(5, 9),
    isPreCreated: Joi.boolean(),
    tableTypeId: Joi.string().custom(objectId),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(10),
    sortBy: Joi.string(),
    populate: Joi.string()
  })
};

const updateTable = {
  params: Joi.object().keys({
    id: Joi.string().custom(objectId).required()
  }),
  body: Joi.object().keys({
    tableTypeId: Joi.string().custom(objectId),
    maxPlayers: Joi.number().valid(5, 9),
    currentPlayers: Joi.array().items(Joi.string().custom(objectId)),
    playerJoiningTimes: Joi.array().items(Joi.object()),
    gameState: Joi.string().custom(objectId),
    dealerPosition: Joi.number().integer().min(0),
    smallBlindPosition: Joi.number().integer().min(0),
    bigBlindPosition: Joi.number().integer().min(0),
    currentTurnPosition: Joi.number().integer().min(0),
    gameRoundsCompleted: Joi.number().integer().min(0),
    blockchainAddress: Joi.string().allow(''),
    tableBlockchainId: Joi.string().allow(''),
    isPreCreated: Joi.boolean(),
    status: Joi.string().valid('available', 'in-use', 'archived')
  }).min(1) // At least one field must be provided for update
};

const deleteTable = {
  params: Joi.object().keys({
    id: Joi.string().required()
  })
};

const getAvailableTables = {
  query: Joi.object().keys({
    maxPlayers: Joi.number().valid(5, 9),
    tableTypeId: Joi.string().custom(objectId),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(10)
  })
};

const findOrCreateTableType = {
  body: Joi.object().keys({
    tableName: Joi.string().required(),
    minBuyIn: Joi.number().required(),
    maxBuyIn: Joi.number().required(),
    maxSeats: Joi.number().integer().min(2).max(10).required(),
    status: Joi.string().valid('active', 'inactive').default('active')
  })
  .unknown(true)
};

module.exports = {
  createTable,
  getTables,
  updateTable,
  deleteTable,
  getAvailableTables,
  findOrCreateTableType
};