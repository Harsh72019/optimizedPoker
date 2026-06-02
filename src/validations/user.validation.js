const Joi = require('joi');
const {objectId} = require('./custom.validation');

const updateUser = {
  body: Joi.object().keys({
    email: Joi.string().trim(),
  }),
};

const updateUserPreferences = {
  body: Joi.object().keys({
    notificationEnabled: Joi.boolean(),
    locationShared: Joi.boolean(),
  }),
};

const checkTableExistence = {
  body: Joi.object().keys({
    playerCount: Joi.number()
      .valid(5, 9)
      .required()
      .messages({
        'any.only': 'Invalid player count. Only 5 or 9 players are allowed.',
        'any.required': 'Player count is required.',
        'number.base': 'Player count must be a number.',
      }),
    chipsInPlay: Joi.number()
      .required()
      .messages({
        'number.base': 'Chip count must be a number.',
      }),
    fundingSource: Joi.string().trim().valid('WEB3', 'CUSTODIAL'),
    // tableTypeId: Joi.string()
    //   .required()
    //   .messages({
    //     'any.required': 'Table type ID is required.',
    //     'string.base': 'Table type ID must be a string.',
    //   }),
  })
  .unknown(true),
};

const saveTableAddress = {
  body: Joi.object().keys({
    playerCount: Joi.number()
      .valid(5, 9)
      .required()
      .messages({
        'any.only': 'Invalid player count. Only 5 or 9 players are allowed.',
        'any.required': 'Player count is required.',
        'number.base': 'Player count must be a number.',
      }),
    tableTypeId: Joi.string()
      .required()
      .messages({
        'any.required': 'Table type ID is required.',
        'string.base': 'Table type ID must be a string.',
      }),
    pendingTableId: Joi.string().custom(objectId),
    tableAddress: Joi.string()
      .required()
      .messages({
        'any.required': 'Table Address  is required.',
        'string.base': 'Table Address  must be a string.',
      }),
    tableId: Joi.string().required(),
  }),
};

const updateUserDetails = {
  body: Joi.object().keys({
    username: Joi.string()
      .trim()
      .required(),
  }),
};

const deleteUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId),
  }),
};

const listTournaments = {
  query: Joi.object().keys({
    page: Joi.number().min(1),
    limit: Joi.number()
      .min(1)
      .max(50),
    sortBy: Joi.string(),
    status: Joi.string().valid('registering', 'scheduled', 'active', 'completed', 'cancelled', 'paused'),
    family: Joi.string().valid('scheduled', 'casual', 'satellite', 'official'),
    rankKey: Joi.string().valid('humens', 'rats', 'cats', 'dogs'),
    templateKey: Joi.string().valid(
      'heads-up-blitz',
      'quick-blitz',
      'fast-table',
      'classic-ring',
      'deep-ring',
      'bounty-rush'
    ),
    buyInMin: Joi.number().min(0),
    buyInMax: Joi.number().min(Joi.ref('buyInMin')),
  }),
};

const registerTournament = {
  params: Joi.object().keys({
    id: Joi.string()
      .custom(objectId)
      .required(),
  }),
  body: Joi.object().keys({
    transactionId: Joi.string(),
    email: Joi.string(),
    name: Joi.string(),
  }).unknown(true),
};

const unregisterTournament = {
  params: Joi.object().keys({
    id: Joi.string()
      .custom(objectId)
      .required(),
  }),
};

const addReferral = {
  body: Joi.object().keys({
    referralCode: Joi.string()
      .trim()
      .uppercase()
      .min(4)
      .max(32)
      .required(),
  }),
};

const friendUser = {
  body: Joi.object().keys({
    userId: Joi.string()
      .trim()
      .required(),
  }),
};

const grantAdReward = {
  body: Joi.object().keys({
    adViewId: Joi.string()
      .trim()
      .min(3)
      .max(120)
      .required(),
  }),
};

const getCustodialReward = {
  body: Joi.object().keys({
    adViewId: Joi.string()
      .trim()
      .min(3)
      .max(120)
      .required(),
  }),
};

const walletAddressAction = {
  body: Joi.object().keys({
    walletAddress: Joi.string()
      .trim()
      .required(),
  }),
};

const custodialDeposit = {
  body: Joi.object().keys({
    amount: Joi.number().positive().required(),
    description: Joi.string().trim().max(160).optional(),
  }),
};

const custodialWithdrawal = {
  body: Joi.object().keys({
    amount: Joi.number().positive().required(),
    walletAddress: Joi.string().trim().optional(),
  }),
};

module.exports = {
  updateUser,
  deleteUser,
  updateUserPreferences,
  updateUserDetails,
  listTournaments,
  registerTournament,
  unregisterTournament,
  checkTableExistence,
  saveTableAddress,
  addReferral,
  friendUser,
  grantAdReward,
  getCustodialReward,
  walletAddressAction,
  custodialDeposit,
  custodialWithdrawal,
};
