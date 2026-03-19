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
    gameType: Joi.string()
      .valid("PRIVATE_SNG", "PRIVATE_TOURNAMENT")
      .required(),

    name: Joi.string()
      .min(3)
      .max(100)
      .trim()
      .required(),

    description: Joi.string()
      .max(1000)
      .allow("", null),

    buyIn: Joi.number()
      .positive()
      .precision(2)
      .required(),

    declaredCapacity: Joi.number()
      .integer()
      .min(2)
      .max(90)
      .required(),

    participationThreshold: Joi.number()
      .valid(25, 50, 75, 100)
      .required(),

    tier: Joi.number()
      .integer()
      .min(1)
      .max(5)
      .required(),

    hostUplift: Joi.number()
      .min(0)
      .max(2.5)
      .default(0),

    hostRewardPercent: Joi.number()
      .min(0)
      .max(25)
      .default(0),

    estimatedHours: Joi.number()
      .min(0.5)
      .max(12)
      .required(),

    timerSeconds: Joi.number()
      .valid(5, 10, 15, 20, 30)
      .required(),

    scheduledStartTime: Joi.date()
      .iso()
      .greater("now")
      .optional(),

    password: Joi.string()
      .min(4)
      .max(20)
      .allow(null, ""),

    tags: Joi.array()
      .items(Joi.string().max(20))
      .max(10)
      .default([])
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
  leavePrivateTable,
  getHostTables,
  getAvailableTables,
  completeGame,
  cancelTable
};