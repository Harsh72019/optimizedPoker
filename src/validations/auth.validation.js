const Joi = require('joi');

const baseRegisterSchema = {
  signature: Joi.string()
    .trim()
    .required(),
  walletAddress: Joi.string()
    .trim()
    .required(),
  consent: Joi.boolean().required(),
};

const login = {
  body: Joi.object().keys({
    ...baseRegisterSchema,
  }),
};

const userVerification = {
  body: Joi.object().keys({
    walletAddress: Joi.string()
      .trim()
      .required(),
    platform: Joi.string(),
  }),
};

const registration = {
  body: Joi.object().keys({
    signature: Joi.string()
      .trim()
      .required(),
    walletAddress: Joi.string()
      .trim()
      .required(),
    consent: Joi.boolean().required(),
  }),
};

module.exports = {
  login,
  userVerification,
  registration,
};
