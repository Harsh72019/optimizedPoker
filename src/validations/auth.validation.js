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
  web2Register: {
    body: Joi.object().keys({
      email: Joi.string().trim().email().required(),
      password: Joi.string().trim().min(6).max(128).required(),
      username: Joi.string().trim().min(3).max(32).optional(),
      referralCode: Joi.string().trim().uppercase().min(4).max(32).optional(),
      consent: Joi.boolean().default(false),
    }),
  },
  web2Login: {
    body: Joi.object().keys({
      email: Joi.string().trim().email().required(),
      password: Joi.string().trim().required(),
    }),
  },
  requestWalletLinkNonce: {
    body: Joi.object().keys({
      walletAddress: Joi.string().trim().required(),
      platform: Joi.string().allow(null, ''),
    }),
  },
  confirmWalletLink: {
    body: Joi.object().keys({
      walletAddress: Joi.string().trim().required(),
      signature: Joi.string().trim().required(),
    }),
  },
};
