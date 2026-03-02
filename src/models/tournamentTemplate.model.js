// models/tournamentTemplate.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const {paginate} = require('./plugins/paginate');

const tournamentTemplateSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    description: String,
    startingChips: {
      type: Number,
      required: true,
    },
    blindProgression: {
      multiplier: {
        type: Number,
        required: true,
        min: 1.1,
        max: 3,
      },
      levels: {
        type: Number,
        required: true,
        min: 5,
        max: 50,
      },
      initialSmallBlind: {
        type: Number,
        required: true,
      },
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

// Method to generate blind levels based on template
tournamentTemplateSchema.methods.generateBlindLevels = function() {
  const levels = [];
  let currentSmallBlind = this.blindProgression.initialSmallBlind;

  for (let level = 1; level <= this.blindProgression.levels; level++) {
    levels.push({
      levelNumber: level,
      smallBlind: currentSmallBlind,
      bigBlind: currentSmallBlind * 2,
    });

    currentSmallBlind = Math.floor(currentSmallBlind * this.blindProgression.multiplier);
  }

  return levels;
};


tournamentTemplateSchema.methods.generateBlindLevelsPreview = function(
  anteStartValue,
  anteStartLevel,
  levelDuration = 15,
  isAnteEnabled
) {
  const levels = [];
  let currentSmallBlind = this.blindProgression.initialSmallBlind;
  const multiplier = this.blindProgression.multiplier;
  const maxLevels = this.blindProgression.levels;

  // Use provided values if defined; otherwise, fallback to template anteConfig if available.
  // If neither is defined, then ante remains 0.
  const defaultAnteStartValue = (this.anteConfig && this.anteConfig.anteStartValue) || 0;
  const defaultAnteStartLevel = (this.anteConfig && this.anteConfig.anteStartLevel) || 1;

  // If the parameters are undefined, use template defaults.
  anteStartValue = typeof anteStartValue !== 'undefined' ? anteStartValue : defaultAnteStartValue;
  anteStartLevel = typeof anteStartLevel !== 'undefined' ? anteStartLevel : defaultAnteStartLevel;

  for (let level = 1; level <= maxLevels; level++) {
    let ante;
    if (anteStartValue > 0) {
      if (level < anteStartLevel) {
        // For levels before the anteStartLevel, ante is 0.
        ante = 0;
      } else if (level === anteStartLevel) {
        // At the anteStartLevel, set the ante to the provided value.
        ante = anteStartValue;
      } else {
        // For subsequent levels, multiply the previous level's ante by the multiplier.
        ante = Math.floor(levels[level - 2].ante * multiplier);
      }
    } else {
      // Ante is not enabled.
      ante = 0;
    }
    let levelData;
    if (isAnteEnabled) {
      levelData = {
        levelNumber: level,
        smallBlind: currentSmallBlind,
        bigBlind: currentSmallBlind * 2,
        levelDuration: `${levelDuration} minutes`,
        ante, // Always include the ante property.
      };
    } else {
      levelData = {
        levelNumber: level,
        smallBlind: currentSmallBlind,
        bigBlind: currentSmallBlind * 2,
        levelDuration: `${levelDuration} minutes`,
      };
    }

    levels.push(levelData);
    currentSmallBlind = Math.floor(currentSmallBlind * multiplier);
  }

  return levels;
};

tournamentTemplateSchema.plugin(paginate);

const TournamentTemplate = mongoose.model('TournamentTemplate', tournamentTemplateSchema);

module.exports = {
  TournamentTemplate,
};
