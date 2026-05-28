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
      name: Joi.string().trim().min(3).max(120),
      description: Joi.string().allow('', null).max(5000),
      family: Joi.string().valid('scheduled', 'casual', 'satellite', 'official').default('scheduled'),
      rankKey: Joi.string().valid('humens', 'rats', 'cats', 'dogs').allow(null, ''),
      rankName: Joi.string().max(50).allow(null, ''),
      templateKey: Joi.string().max(50).allow(null, ''),
      templateName: Joi.string().max(120).allow(null, ''),
      visibilityTier: Joi.string().valid('A', 'B', 'C').default('A'),
      timeZone: Joi.string().default('UTC'),
      templateId: Joi.string().allow(null, ''),
      registrationDeadline: Joi.date().iso().required(),
      startTime: Joi.date().iso().required(),
      maxPlayers: Joi.number().integer().min(2).max(500).default(90),
      minPlayersPerTable: Joi.number().integer().min(2).max(9).default(2),
      maxPlayersPerTable: Joi.number().integer().min(2).max(9).default(9),
      buyIn: Joi.number().positive(),
      startingChips: Joi.number().integer().min(1).default(10000),
      rakePercentage: Joi.number().min(5).max(8).default(6),
      payoutStructure: Joi.array().items(payoutRow).min(1),
      blindLevels: Joi.array().items(blindLevel).min(1),
      levelDuration: Joi.number().integer().min(1).max(180).default(15),
      tournamentDuration: Joi.number().integer().min(0).max(72).default(0),
      timerSeconds: Joi.number().integer().min(5).max(300).default(20),
      quickStartConfig: Joi.object({
        enabled: Joi.boolean().default(false),
        minPlayers: Joi.number().integer().min(2).max(9),
        countdownSeconds: Joi.number().integer().min(0).max(180).default(0),
        consentRequired: Joi.boolean().default(false),
      }),
      startRule: Joi.string().valid('START_ON_FILL', 'QUICK_START_ALLOWED').default('START_ON_FILL'),
      preStartAnonymity: Joi.object({
        enabled: Joi.boolean().default(true),
        revealAt: Joi.string().default('TOURNAMENT_START'),
      }),
      hotPoolStatus: Joi.object({
        ready: Joi.boolean().default(false),
        readyInstances: Joi.number().integer().min(0).default(0),
        spawnOnDemand: Joi.boolean().default(true),
        lastSpawnedAt: Joi.date().iso().allow(null),
      }),
      bountyConfig: Joi.object({
        model: Joi.string().valid('flat', 'progressive'),
        bountyShareOfBuyIn: Joi.number().min(0).max(1),
        instantPayout: Joi.boolean().default(true),
      }),
      isOfficial: Joi.boolean().default(true),
    })
    .custom((value, helpers) => {
      if (new Date(value.registrationDeadline) >= new Date(value.startTime)) {
        return helpers.message('Registration deadline must be before tournament start time');
      }

      const isCasual = value.family === 'casual';

      if (!isCasual && !value.name) {
        return helpers.message('name is required');
      }

      if (!isCasual && !value.buyIn) {
        return helpers.message('buyIn is required');
      }

      if (!isCasual && (!Array.isArray(value.payoutStructure) || value.payoutStructure.length === 0)) {
        return helpers.message('payoutStructure is required');
      }

      if (isCasual) {
        if (!value.rankKey) {
          return helpers.message('rankKey is required for casual tournaments');
        }

        if (!value.templateKey) {
          return helpers.message('templateKey is required for casual tournaments');
        }
      }

      if (Array.isArray(value.payoutStructure) && value.payoutStructure.length > 0) {
        const payoutTotal = value.payoutStructure.reduce(
          (sum, row) => sum + Number(row.percentage || 0),
          0
        );
        if (Math.abs(payoutTotal - 100) > 0.01) {
          return helpers.message('Payout structure must total 100%');
        }
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
