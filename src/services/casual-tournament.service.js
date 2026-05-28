const mongoHelper = require('../models/customdb');
const {
  CASUAL_TOURNAMENT_FAMILY,
  CASUAL_RANKS,
  CASUAL_TEMPLATE_DEFINITIONS,
  CASUAL_PAYOUT_PRESETS,
} = require('../constants/casual-tournament.constants');

class CasualTournamentService {
  normalizeAmount(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) {
      return 0;
    }

    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }

  getRank(rankKey) {
    const rank = CASUAL_RANKS.find(entry => entry.key === rankKey);
    if (!rank) {
      throw new Error(`Unknown casual tournament rank: ${rankKey}`);
    }

    return rank;
  }

  getTemplate(templateKey) {
    const template = CASUAL_TEMPLATE_DEFINITIONS.find(entry => entry.key === templateKey);
    if (!template) {
      throw new Error(`Unknown casual tournament template: ${templateKey}`);
    }

    return template;
  }

  getPayoutPreset(presetKey) {
    return CASUAL_PAYOUT_PRESETS[presetKey] || [{ position: 1, percentage: 100 }];
  }

  isCasualTournamentConfig(config = {}) {
    return (config.family || '').toString().toLowerCase() === CASUAL_TOURNAMENT_FAMILY;
  }

  scaleForRank(baseValue, rankNumber, precision = 0) {
    const scaled = Number(baseValue || 0) * Math.pow(2, Math.max(0, rankNumber - 1));
    if (precision === 0) {
      return Math.round(scaled);
    }

    return Number(scaled.toFixed(precision));
  }

  buildBuyInBreakdown({ buyIn, rakePercentage, bountyShareOfBuyIn = 0 }) {
    const normalizedBuyIn = this.normalizeAmount(buyIn);
    const fee = this.normalizeAmount(normalizedBuyIn * (Number(rakePercentage || 0) / 100));
    const bounty = this.normalizeAmount(normalizedBuyIn * Number(bountyShareOfBuyIn || 0));
    const prizePoolContribution = this.normalizeAmount(normalizedBuyIn - fee - bounty);

    return {
      totalBuyIn: normalizedBuyIn,
      fee,
      prizePoolContribution,
      bountyContribution: bounty,
      currency: 'USD',
    };
  }

  buildBlindSchedule(rankKey, templateKey) {
    const rank = this.getRank(rankKey);
    const template = this.getTemplate(templateKey);
    const {
      blindLevels,
      initialSmallBlind,
      blindMultiplier,
      anteStartLevel,
      anteStartRatio,
      levelDurationMinutes,
      startingChips,
    } = template.defaults;

    const scaledStartingChips = this.scaleForRank(startingChips, rank.rankNumber);
    let smallBlind = this.scaleForRank(initialSmallBlind, rank.rankNumber);
    const levels = [];

    for (let levelNumber = 1; levelNumber <= blindLevels; levelNumber += 1) {
      const bigBlind = smallBlind * 2;
      const ante = levelNumber >= anteStartLevel
        ? Math.max(0, Math.round(bigBlind * anteStartRatio))
        : 0;

      levels.push({
        levelNumber,
        smallBlind,
        bigBlind,
        ante,
        durationMinutes: levelDurationMinutes,
        startingChips: scaledStartingChips,
      });

      smallBlind = Math.max(smallBlind + 1, Math.round(smallBlind * blindMultiplier));
    }

    return levels;
  }

  buildCasualTournamentConfig(config = {}) {
    if (!this.isCasualTournamentConfig(config)) {
      return {...config};
    }

    const rank = this.getRank(config.rankKey);
    const template = this.getTemplate(config.templateKey);
    const allowedBuyIns = template.buyInsByRank?.[rank.key] || [];
    const requestedBuyIn = Number(config.buyIn);
    const buyIn = Number.isFinite(requestedBuyIn) && requestedBuyIn > 0
      ? requestedBuyIn
      : allowedBuyIns[0];

    if (!allowedBuyIns.includes(buyIn)) {
      throw new Error(
        `Buy-in ${buyIn} is not allowed for ${rank.name} ${template.name}. Allowed: ${allowedBuyIns.join(', ')}`
      );
    }

    const blindLevels = this.buildBlindSchedule(rank.key, template.key).map(level => ({
      levelNumber: level.levelNumber,
      smallBlind: level.smallBlind,
      bigBlind: level.bigBlind,
      ante: level.ante,
      duration: level.durationMinutes,
    }));
    const firstLevel = blindLevels[0];
    const startingChips = Number(config.startingChips || firstLevel?.startingChips || 0) || this.scaleForRank(template.defaults.startingChips, rank.rankNumber);
    const rakePercentage = Number(config.rakePercentage ?? rank.defaultRakePercentage);
    const payoutStructure = config.payoutStructure?.length
      ? config.payoutStructure
      : this.getPayoutPreset(template.payoutPreset);
    const generatedName = `${rank.name} ${template.name} $${buyIn}`;

    return {
      ...config,
      name: config.name || generatedName,
      rankName: config.rankName || rank.name,
      templateName: config.templateName || template.name,
      buyIn,
      maxPlayers: Number(config.maxPlayers || template.maxPlayers),
      minPlayersPerTable: Number(config.minPlayersPerTable || template.minPlayersToStart),
      maxPlayersPerTable: Number(config.maxPlayersPerTable || template.maxPlayers),
      startingChips,
      levelDuration: Number(config.levelDuration || template.defaults.levelDurationMinutes),
      blindLevels,
      payoutStructure,
      rakePercentage,
      visibilityTier: config.visibilityTier || template.visibleTier || 'A',
      quickStartConfig: {
        enabled: config.quickStartConfig?.enabled ?? (template.quickStartMinPlayers < template.maxPlayers),
        minPlayers: Number(config.quickStartConfig?.minPlayers || template.quickStartMinPlayers),
        countdownSeconds: Number(config.quickStartConfig?.countdownSeconds || template.quickStartCountdownSeconds || 0),
        consentRequired: !!config.quickStartConfig?.consentRequired,
      },
      startRule: config.startRule || ((template.quickStartMinPlayers < template.maxPlayers) ? 'QUICK_START_ALLOWED' : 'START_ON_FILL'),
      preStartAnonymity: {
        enabled: config.preStartAnonymity?.enabled !== false,
        revealAt: config.preStartAnonymity?.revealAt || 'TOURNAMENT_START',
      },
      hotPoolStatus: {
        ready: !!config.hotPoolStatus?.ready,
        readyInstances: Number(config.hotPoolStatus?.readyInstances || 0),
        spawnOnDemand: config.hotPoolStatus?.spawnOnDemand !== false,
        lastSpawnedAt: config.hotPoolStatus?.lastSpawnedAt || null,
      },
      bountyConfig: template.bountyConfig
        ? {
            ...template.bountyConfig,
            instantPayout: config.bountyConfig?.instantPayout !== false,
            ...config.bountyConfig,
          }
        : config.bountyConfig,
      metadata: {
        ...(config.metadata || {}),
        rank: {
          key: rank.key,
          code: rank.code,
          name: rank.name,
          rankNumber: rank.rankNumber,
        },
        template: {
          key: template.key,
          name: template.name,
          shortCode: template.shortCode,
          gameType: template.gameType,
          speed: template.speed,
          runtimeMinutes: template.runtimeMinutes,
        },
      },
    };
  }

  buildScheduleCsvRows() {
    const rows = [
      [
        'rankKey',
        'rankName',
        'templateKey',
        'templateName',
        'levelNumber',
        'smallBlind',
        'bigBlind',
        'ante',
        'durationMinutes',
        'startingChips',
      ],
    ];

    CASUAL_RANKS.forEach(rank => {
      CASUAL_TEMPLATE_DEFINITIONS.forEach(template => {
        this.buildBlindSchedule(rank.key, template.key).forEach(level => {
          rows.push([
            rank.key,
            rank.name,
            template.key,
            template.name,
            level.levelNumber,
            level.smallBlind,
            level.bigBlind,
            level.ante,
            level.durationMinutes,
            level.startingChips,
          ]);
        });
      });
    });

    return rows;
  }

  buildScheduleCsvString() {
    return this.buildScheduleCsvRows()
      .map(row => row.join(','))
      .join('\n');
  }

  async listVisibleInstances(rankKey, includeHidden = false) {
    const query = {
      family: CASUAL_TOURNAMENT_FAMILY,
      rankKey,
      isPrivate: false,
    };

    if (!includeHidden) {
      query.visibilityTier = 'A';
    }

    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENTS, query);
    if (!result.success) {
      throw new Error(result.error || 'Failed to load casual tournament instances');
    }

    return result.data || [];
  }

  buildTemplateCard(rankKey, templateDefinition) {
    const rank = this.getRank(rankKey);
    const allowedBuyIns = templateDefinition.buyInsByRank?.[rankKey] || [];
    const defaultBuyIn = allowedBuyIns[0] || rank.buyIns[0];
    const breakdown = this.buildBuyInBreakdown({
      buyIn: defaultBuyIn,
      rakePercentage: rank.defaultRakePercentage,
      bountyShareOfBuyIn: templateDefinition.bountyConfig?.bountyShareOfBuyIn || 0,
    });

    return {
      family: CASUAL_TOURNAMENT_FAMILY,
      rank: {
        key: rank.key,
        code: rank.code,
        name: rank.name,
        rankNumber: rank.rankNumber,
      },
      template: {
        key: templateDefinition.key,
        name: templateDefinition.name,
        shortCode: templateDefinition.shortCode,
        gameType: templateDefinition.gameType,
        speed: templateDefinition.speed,
        maxPlayers: templateDefinition.maxPlayers,
        minPlayersToStart: templateDefinition.minPlayersToStart,
        visibleTier: templateDefinition.visibleTier,
      },
      availableBuyIns: allowedBuyIns,
      buyInBreakdown: breakdown,
      quickStart: {
        enabled: templateDefinition.quickStartMinPlayers < templateDefinition.maxPlayers,
        minPlayers: templateDefinition.quickStartMinPlayers,
        countdownSeconds: templateDefinition.quickStartCountdownSeconds,
      },
      hotPool: {
        targetReadyInstances: templateDefinition.visibleTier === 'A' ? 1 : 0,
        spawnOnDemand: true,
      },
      startingStack: this.scaleForRank(templateDefinition.defaults.startingChips, rank.rankNumber),
      levelDurationMinutes: templateDefinition.defaults.levelDurationMinutes,
      runtimeEstimateMinutes: templateDefinition.runtimeMinutes,
      preStartAnonymity: {
        enabled: true,
        revealAt: 'TOURNAMENT_START',
      },
      payoutPreset: this.getPayoutPreset(templateDefinition.payoutPreset),
      blindSchedulePreview: this.buildBlindSchedule(rankKey, templateDefinition.key).slice(0, 5),
      bountyConfig: templateDefinition.bountyConfig
        ? {
            ...templateDefinition.bountyConfig,
            sampleBreakdown: this.buildBuyInBreakdown({
              buyIn: defaultBuyIn,
              rakePercentage: rank.defaultRakePercentage,
              bountyShareOfBuyIn: templateDefinition.bountyConfig.bountyShareOfBuyIn,
            }),
          }
        : null,
    };
  }

  async buildLobby(rankKey, options = {}) {
    const includeHidden = options.includeHidden === true;
    const visibleInstances = await this.listVisibleInstances(rankKey, includeHidden);
    const templates = CASUAL_TEMPLATE_DEFINITIONS
      .filter(template => includeHidden || template.visibleTier === 'A')
      .map(template => this.buildTemplateCard(rankKey, template));

    const instanceList = visibleInstances.map(instance => {
      const maxPlayers = Number(instance.maxPlayersPerTable || instance.maxPlayers || 0);
      const registeredSeats = Array.from({ length: Math.max(0, (instance.players || []).length) }, (_, index) => ({
        seatPosition: index + 1,
        displayName: `Player ${index + 1}`,
        isAnonymous: instance.status !== 'active',
      }));

      return {
        tournamentId: instance._id?.toString?.() || instance._id,
        name: instance.name,
        status: instance.status,
        family: instance.family || CASUAL_TOURNAMENT_FAMILY,
        rankKey: instance.rankKey,
        templateKey: instance.templateKey,
        visibleTier: instance.visibilityTier || 'A',
        buyIn: Number(instance.buyIn || 0),
        buyInBreakdown: instance.buyInBreakdown || null,
        quickStart: instance.quickStartConfig || null,
        seats: {
          filled: registeredSeats.length,
          total: maxPlayers,
          anonymized: registeredSeats,
        },
        hotPoolStatus: instance.hotPoolStatus || {
          ready: instance.status === 'registering',
          source: 'db',
        },
        startPolicy: instance.startRule || 'START_ON_FILL',
        startsAt: instance.startTime,
      };
    });

    return {
      family: CASUAL_TOURNAMENT_FAMILY,
      generatedAt: new Date().toISOString(),
      rank: this.getRank(rankKey),
      templates,
      instances: instanceList,
      visibilityModel: {
        strategy: 'ACTIVE_TIER_ROTATION',
        activeTier: includeHidden ? 'ALL' : 'A',
        nextTierRevealRule: 'Reveal Tier B when Tier A tables start filling or become active',
      },
      transparency: {
        showBuyInBreakdown: true,
        showPayoutTables: true,
        showQuickStartRules: true,
        showAnonymizationBadge: true,
      },
    };
  }

  getPayoutPresets() {
    return Object.entries(CASUAL_PAYOUT_PRESETS).map(([key, payouts]) => ({
      key,
      payouts,
    }));
  }

  decorateTournament(tournament) {
    if (!tournament || tournament.family !== CASUAL_TOURNAMENT_FAMILY || !tournament.rankKey || !tournament.templateKey) {
      return tournament;
    }

    const rank = CASUAL_RANKS.find(entry => entry.key === tournament.rankKey);
    const template = CASUAL_TEMPLATE_DEFINITIONS.find(entry => entry.key === tournament.templateKey);

    return {
      ...tournament,
      casualConfig: rank && template ? {
        rank: {
          key: rank.key,
          name: rank.name,
          rankNumber: rank.rankNumber,
        },
        template: {
          key: template.key,
          name: template.name,
          shortCode: template.shortCode,
          speed: template.speed,
          gameType: template.gameType,
        },
        buyInBreakdown: tournament.buyInBreakdown || this.buildBuyInBreakdown({
          buyIn: Number(tournament.buyIn || 0),
          rakePercentage: Number(tournament.rakePercentage || rank.defaultRakePercentage),
          bountyShareOfBuyIn: Number(tournament.bountyConfig?.bountyShareOfBuyIn || 0),
        }),
        quickStartConfig: tournament.quickStartConfig || null,
        preStartAnonymity: tournament.preStartAnonymity || null,
      } : null,
    };
  }
}

module.exports = new CasualTournamentService();
