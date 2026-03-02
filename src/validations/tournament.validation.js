const Joi = require('joi');
const {objectId} = require('./custom.validation');

const createTournament = {
  body: Joi.object()
    .keys({
      name: Joi.string()
        .trim()
        .required(),
      description: Joi.string().required(),
      timeZone: Joi.string().required(),
      templateId: Joi.string()
        // .custom(objectId)
        .required(),
      registrationDeadline: Joi.date()
        .iso()
        .required(),
      startTime: Joi.date()
        .iso()
        .required(),
      maxPlayers: Joi.number()
        .integer()
        .min(2)
        .required(),
      minPlayersPerTable: Joi.number()
        .integer()
        .min(2)
        .required(),
      maxPlayersPerTable: Joi.number()
        .integer()
        .min(2)
        .required(),
      buyIn: Joi.number()
        .positive()
        .required(),
      payoutStructure: Joi.array()
        .items(
          Joi.object().keys({
            position: Joi.number()
              .integer()
              .positive()
              .required(),
            percentage: Joi.number()
              .min(0)
              .max(100)
              .required(),
          })
        )
        .min(1)
        .required(),
      // New ante configuration
      anteConfig: Joi.object().keys({
        enabled: Joi.boolean().default(false),
        startLevel: Joi.number()
          .integer()
          .min(1)
          .max(10)
          .default(3),
        initialValue: Joi.number()
          .integer()
          .min(1)
          .max(1000)
          .default(25),
      }),
      // New rebuy configuration
      rebuyConfig: Joi.object().keys({
        enabled: Joi.boolean().default(false),
        attemptLimit: Joi.number()
          .integer()
          .min(0)
          .max(12)
          .default(2),
        timeLimit: Joi.number()
          .integer()
          .min(15)
          .max(240)
          .default(60),
      }),
      // New level advancement configuration
      levelDuration: Joi.number()
        .integer()
        .min(2)
        .max(60)
        .default(15)
        .required(),
      // New tournament duration and pause schedule
      tournamentDuration: Joi.number()
        .integer()
        .min(0)
        .max(72)
        .default(0),
      pauseSchedule: Joi.array().items(
        Joi.object().keys({
          pauseAt: Joi.date()
            .iso()
            .required(),
          resumeAt: Joi.date()
            .iso()
            .required(),
        })
      ),
    })
    .custom((value, helpers) => {
      if (new Date(value.registrationDeadline) >= new Date(value.startTime)) {
        return helpers.message('Registration deadline must be before tournament start time');
      }

      // Validate pause schedule times if provided
      if (value.pauseSchedule && value.pauseSchedule.length > 0) {
        for (const schedule of value.pauseSchedule) {
          if (new Date(schedule.pauseAt) < new Date(value.startTime)) {
            return helpers.message('Pause time must be after tournament start time');
          }
          if (new Date(schedule.resumeAt) <= new Date(schedule.pauseAt)) {
            return helpers.message('Resume time must be after pause time');
          }
        }
      }

      return value;
    }),
};

const updateTournament = {
  params: Joi.object().keys({
    id: Joi.string()
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim(),
      description: Joi.string(),
      templateId: Joi.string(),
      registrationDeadline: Joi.date().iso(),
      startTime: Joi.date().iso(),
      maxPlayers: Joi.number()
        .integer()
        .min(2),
      minPlayersPerTable: Joi.number()
        .integer()
        .min(2),
      maxPlayersPerTable: Joi.number()
        .integer()
        .min(2),
      buyIn: Joi.number().positive(),
      payoutStructure: Joi.array()
        .items(
          Joi.object().keys({
            position: Joi.number()
              .integer()
              .positive()
              .required(),
            percentage: Joi.number()
              .min(0)
              .max(100)
              .required(),
          })
        )
        .min(1),
      // New ante configuration
      anteConfig: Joi.object().keys({
        enabled: Joi.boolean(),
        startLevel: Joi.number()
          .integer()
          .min(1),
        initialValue: Joi.number()
          .integer()
          .min(1),
      }),
      // New rebuy configuration
      rebuyConfig: Joi.object().keys({
        enabled: Joi.boolean(),
        attemptLimit: Joi.number()
          .integer()
          .min(0)
          .max(10),
        timeLimit: Joi.number()
          .integer()
          .min(15)
          .max(240),
      }),
    })
    .custom((value, helpers) => {
      if (
        value.registrationDeadline &&
        value.startTime &&
        new Date(value.registrationDeadline) >= new Date(value.startTime)
      ) {
        return helpers.message('Registration deadline must be before tournament start time');
      }
      return value;
    }),
};

const getTournamentById = {
  params: Joi.object().keys({
    id: Joi.string()
  }),
};

const previewTournamentProgression = {
  body: Joi.object().keys({
    templateId: Joi.string(),
    levelDuration: Joi.number()
      .integer()
      .min(2)
      .max(60)
      .default(15)
      .required(),
    anteStartValue: Joi.number().min(0),
    anteStartLevel: Joi.number()
      .integer()
      .min(1),
    isAnteEnabled: Joi.boolean().default(false),
  }),
};

const deleteTournament = {
  params: Joi.object().keys({
    id: Joi.string()
  }),
};

module.exports = {
  createTournament,
  updateTournament,
  getTournamentById,
  deleteTournament,
  previewTournamentProgression,
};
