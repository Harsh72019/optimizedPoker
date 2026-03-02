const mongoHelper = require('../models/customdb');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');

const createTemplate = async (templateData) => {
  try {
    // Blind level validation before insert
    const blindLevels = generateBlindLevels(templateData.blindProgression);
    if (!blindLevels || blindLevels.length === 0) {
      throw new Error('Invalid blind progression structure');
    }

    const result = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TOURNAMENT_TEMPLATES,
      templateData,
      mongoHelper.MODELS.TOURNAMENT_TEMPLATE
    );

    if (!result.success) {
      if (result.error?.includes('duplicate')) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Template name already exists');
      }
      throw new Error(result.error);
    }

    return result.data;
  } catch (error) {
    throw new ApiError(error.statusCode || httpStatus.BAD_REQUEST, error.message);
  }
};

const listTemplates = async (status, search, options = {}) => {
  try {
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }

    if (options && Object.keys(options).length > 0) {
      return await mongoHelper.paginate(
        mongoHelper.COLLECTIONS.TOURNAMENT_TEMPLATES,
        filter,
        options.page || 1,
        options.limit || 10
      );
    } else {
      const result = await mongoHelper.filter(
        mongoHelper.COLLECTIONS.TOURNAMENT_TEMPLATES,
        filter
      );

      if (!result.success) {
        throw new Error(result.error);
      }
      console.log(result.data);
      return result.data.map((doc) => ({
        _id: doc._id,
        name: doc.name,
        startingChips: doc.startingChips,
        blindProgression: {
          levels: doc.blindProgression?.levels,
          multiplier: doc.blindProgression?.multiplier,
        },
      }));
    }
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const getTemplateById = async (id) => {
  try {
    const result = await mongoHelper.findById(
      mongoHelper.COLLECTIONS.TOURNAMENT_TEMPLATES,
      id
    );

    if (!result.success || !result.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
    }

    const template = result.data;
    const blindLevels = generateBlindLevels(template.blindProgression);

    return {
      ...template,
      blindLevels,
    };
  } catch (error) {
    throw new ApiError(error.statusCode || httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const updateTemplate = async (id, updateData) => {
  try {
    // Validate progression
    const blindLevels = generateBlindLevels(updateData.blindProgression);
    if (!blindLevels || blindLevels.length === 0) {
      throw new Error('Invalid blind progression structure');
    }

    const result = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENT_TEMPLATES,
      id,
      updateData,
      mongoHelper.MODELS.TOURNAMENT_TEMPLATE
    );

    if (!result.success || !result.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
    }

    return result.data;
  } catch (error) {
    throw new ApiError(error.statusCode || httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

const deleteTemplate = async (id) => {
  try {
    const existing = await mongoHelper.findById(
      mongoHelper.COLLECTIONS.TOURNAMENT_TEMPLATES,
      id
    );

    if (!existing.success || !existing.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
    }

    const result = await mongoHelper.deleteById(
      mongoHelper.COLLECTIONS.TOURNAMENT_TEMPLATES,
      id
    );

    if (!result.success) {
      throw new Error('Failed to delete template');
    }

    return true;
  } catch (error) {
    throw new ApiError(error.statusCode || httpStatus.INTERNAL_SERVER_ERROR, error.message);
  }
};

// Utility function for blind level generation (pure function equivalent)
function generateBlindLevels(progression) {
  try {
    const { multiplier = 1, levels = 10, initialSmallBlind = 50 } = progression || {};
    if (!multiplier || !levels || !initialSmallBlind) return [];

    const result = [];
    let sb = initialSmallBlind;

    for (let i = 0; i < levels; i++) {
      result.push({ level: i + 1, smallBlind: sb, bigBlind: sb * 2 });
      sb = Math.ceil(sb * multiplier);
    }

    return result;
  } catch {
    return [];
  }
}

module.exports = {
  createTemplate,
  listTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
};
