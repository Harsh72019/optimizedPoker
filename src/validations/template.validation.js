// validations/tournamentTemplate.validation.js
const Joi = require('joi');
const {objectId} = require('./custom.validation');

const createTemplate = {
  body: Joi.object().keys({
    name: Joi.string()
      .required()
      .min(3)
      .max(100),
    description: Joi.string().max(500),
    startingChips: Joi.number()
      .required()
      .min(1000),
    blindProgression: Joi.object({
      multiplier: Joi.number()
        .required()
        .min(1.1)
        .max(3),
      levels: Joi.number()
        .required()
        .min(5)
        .max(50),
      initialSmallBlind: Joi.number()
        .required()
        .min(1),
    }).required(),
    status: Joi.string()
      .valid('active', 'inactive')
      .default('active'),
  }),
};

const getTemplate = {
  params: Joi.object().keys({
    id: Joi.string()
      .required(),
  }),
};

const updateTemplate = {
  params: Joi.object().keys({
    id: Joi.string()
      .required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string()
        .min(3)
        .max(100),
      description: Joi.string().max(500),
      startingChips: Joi.number().min(1000),
      blindProgression: Joi.object({
        multiplier: Joi.number()
          .min(1.1)
          .max(3),
        levels: Joi.number()
          .min(5)
          .max(50),
        initialSmallBlind: Joi.number().min(1),
      }),
      status: Joi.string().valid('active', 'inactive'),
    })
    .min(1),
};

const deleteTemplate = {
  params: Joi.object().keys({
    id: Joi.string()
      .required(),
  }),
};

module.exports = {
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
};
