const Joi = require('joi');

const idParam = {
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
};

const blindLevel = Joi.object().keys({
  levelNumber: Joi.number().integer().min(1),
  level: Joi.number().integer().min(1),
  smallBlind: Joi.number().positive().required(),
  bigBlind: Joi.number().positive(),
  ante: Joi.number().min(0).default(0),
  duration: Joi.number().integer().min(1).max(180).default(15),
});

const payoutRow = Joi.object().keys({
  position: Joi.number().integer().positive().required(),
  percentage: Joi.number().min(0).max(100).required(),
});

const createTournament = {
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(3).max(120).required(),
      description: Joi.string().allow('', null).max(5000),
      timeZone: Joi.string().default('UTC'),
      templateId: Joi.string().allow(null, ''),
      registrationDeadline: Joi.date().iso().required(),
      startTime: Joi.date().iso().required(),
      maxPlayers: Joi.number().integer().min(2).max(500).default(90),
      minPlayersPerTable: Joi.number().integer().min(2).max(9).default(2),
      maxPlayersPerTable: Joi.number().integer().min(2).max(9).default(9),
      buyIn: Joi.number().positive().required(),
      startingChips: Joi.number().integer().min(1).default(10000),
      rakePercentage: Joi.number().min(5).max(8).default(6),
      payoutStructure: Joi.array().items(payoutRow).min(1).required(),
      blindLevels: Joi.array().items(blindLevel).min(1),
      levelDuration: Joi.number().integer().min(1).max(180).default(15),
      tournamentDuration: Joi.number().integer().min(0).max(72).default(0),
      timerSeconds: Joi.number().integer().min(5).max(300).default(20),
      isOfficial: Joi.boolean().default(true),
    })
    .custom((value, helpers) => {
      if (new Date(value.registrationDeadline) >= new Date(value.startTime)) {
        return helpers.message('Registration deadline must be before tournament start time');
      }

      const payoutTotal = (value.payoutStructure || []).reduce(
        (sum, row) => sum + Number(row.percentage || 0),
        0
      );
      if (Math.abs(payoutTotal - 100) > 0.01) {
        return helpers.message('Payout structure must total 100%');
      }

      if (Number(value.minPlayersPerTable) > Number(value.maxPlayersPerTable)) {
        return helpers.message('minPlayersPerTable cannot exceed maxPlayersPerTable');
      }

      return value;
    }),
};

module.exports = {
  createTournament,
  getTournamentById: idParam,
  startTournament: idParam,
  registerTournament: idParam,
  getMyTableAssignment: idParam,
};
