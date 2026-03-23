const Joi = require("joi");

/* ------------------------------------------------ */
/* COMMON */
/* ------------------------------------------------ */

const objectId = Joi.string().regex(/^[0-9a-fA-F]{24}$/);

const tableId = Joi.string().pattern(/^pvt_[a-zA-Z0-9\-_]+$/);


/* ------------------------------------------------ */
/* CREATE PRIVATE TABLE */
/* ------------------------------------------------ */

const createPrivateTable = {
  body: Joi.object({
    // New private table configuration structure
    name: Joi.string()
      .min(3)
      .max(100)
      .trim()
      .required(),

    description: Joi.string()
      .max(1000)
      .allow("", null),

    gameType: Joi.string()
      .valid("SNG", "TOURNAMENT")
      .required(),

    // Stakes configuration
    stakes: Joi.object({
      type: Joi.string()
        .valid("FIXED_LIMIT", "POT_LIMIT", "NO_LIMIT", "CUSTOM")
        .required(),
      blinds: Joi.object({
        small: Joi.number().positive().required(),
        big: Joi.number().positive().required()
      }).required()
    }).required(),

    // Timer configuration
    turnTimer: Joi.number()
      .integer()
      .min(5)
      .max(300)
      .required(),

    // Player capacity
    playerCapacity: Joi.object({
      min: Joi.number().integer().min(2).max(90).required(),
      max: Joi.number().integer().min(2).max(90).required()
    }).required(),

    // Table duration
    tableDuration: Joi.string()
      .valid("TIMED", "INFINITY")
      .required(),

    // Buy-in settings
    buyInSettings: Joi.object({
      min: Joi.number().positive().required(),
      max: Joi.number().positive().required()
    }).required(),

    // Invitation control
    invitationControl: Joi.object({
      type: Joi.string().valid("PASSWORD", "INVITE").required(),
      password: Joi.string().min(4).max(20).when('type', {
        is: 'PASSWORD',
        then: Joi.required(),
        otherwise: Joi.optional()
      })
    }).required(),

    // Features
    rebuy: Joi.boolean().default(false),
    antesStraddles: Joi.boolean().default(false),
    buyInReentryRules: Joi.string()
      .valid("ALLOWED_ON_REBUY_ONLY", "ALWAYS_ALLOWED", "NEVER_ALLOWED")
      .default("ALLOWED_ON_REBUY_ONLY"),

    // Legacy fields for backward compatibility (optional)
    buyIn: Joi.number().positive().optional(),
    declaredCapacity: Joi.number().integer().min(2).max(90).optional(),
    participationThreshold: Joi.number().valid(25, 50, 75, 100).optional(),
    tier: Joi.number().integer().min(1).max(5).default(3),
    hostUplift: Joi.number().min(0).max(2.5).default(0),
    hostRewardPercent: Joi.number().min(0).max(25).default(0),
    estimatedHours: Joi.number().min(0.5).max(12).default(2),
    timerSeconds: Joi.number().optional(),
    scheduledStartTime: Joi.date().iso().greater("now").optional(),
    allowSpectators: Joi.boolean().default(false),
    tags: Joi.array().items(Joi.string().max(20)).max(10).default([])
  }).options({ stripUnknown: true })
};


/* ------------------------------------------------ */
/* GET TABLE */
/* ------------------------------------------------ */

const getPrivateTable = {
  params: Joi.object({
    tableId: tableId.required()
  })
};


/* ------------------------------------------------ */
/* JOIN TABLE */
/* ------------------------------------------------ */

const joinPrivateTable = {
  params: Joi.object({
    tableId: tableId.required()
  }),

  body: Joi.object({
    password: Joi.string()
      .min(4)
      .max(20)
      .allow("", null)
  }).options({ stripUnknown: true })
};


/* ------------------------------------------------ */
/* START PRIVATE TABLE */
/* ------------------------------------------------ */

const startPrivateTable = {
  params: Joi.object({
    tableId: tableId.required()
  })
};

/* ------------------------------------------------ */
/* LEAVE TABLE */
/* ------------------------------------------------ */

const leavePrivateTable = {
  params: Joi.object({
    tableId: tableId.required()
  })
};


/* ------------------------------------------------ */
/* HOST TABLES */
/* ------------------------------------------------ */

const getHostTables = {
  query: Joi.object({

    status: Joi.string()
      .valid(
        "CREATED",
        "WAITING_FOR_PLAYERS",
        "ACTIVE",
        "COMPLETED",
        "CANCELLED"
      ),

    gameType: Joi.string()
      .valid("PRIVATE_SNG", "PRIVATE_TOURNAMENT"),

    page: Joi.number()
      .integer()
      .min(1)
      .default(1),

    limit: Joi.number()
      .integer()
      .min(1)
      .max(100)
      .default(10)

  }).options({ stripUnknown: true })
};


/* ------------------------------------------------ */
/* AVAILABLE TABLES */
/* ------------------------------------------------ */

const getAvailableTables = {
  query: Joi.object({

    gameType: Joi.string()
      .valid("PRIVATE_SNG", "PRIVATE_TOURNAMENT"),

    minBuyIn: Joi.number()
      .positive(),

    maxBuyIn: Joi.number()
      .positive()
      .when("minBuyIn", {
        is: Joi.exist(),
        then: Joi.number().greater(Joi.ref("minBuyIn"))
      }),

    page: Joi.number()
      .integer()
      .min(1)
      .default(1),

    limit: Joi.number()
      .integer()
      .min(1)
      .max(100)
      .default(20)

  }).options({ stripUnknown: true })
};


/* ------------------------------------------------ */
/* COMPLETE GAME */
/* ------------------------------------------------ */

const completeGame = {
  params: Joi.object({
    tableId: tableId.required()
  }),

  body: Joi.object({

    winners: Joi.array()
      .items(
        Joi.object({
          position: Joi.number()
            .integer()
            .min(1)
            .required(),

          userId: objectId.required(),

          prize: Joi.number()
            .min(0)
            .precision(2)
            .required()
        })
      )
      .min(1)
      .max(90)
      .required()

  }).options({ stripUnknown: true })
};


/* ------------------------------------------------ */
/* CANCEL TABLE */
/* ------------------------------------------------ */

const cancelTable = {
  params: Joi.object({
    tableId: tableId.required()
  }),

  body: Joi.object({

    reason: Joi.string()
      .min(5)
      .max(200)
      .trim()
      .required()

  }).options({ stripUnknown: true })
};


module.exports = {
  createPrivateTable,
  getPrivateTable,
  joinPrivateTable,
  startPrivateTable,
  leavePrivateTable,
  getHostTables,
  getAvailableTables,
  cancelTable
};