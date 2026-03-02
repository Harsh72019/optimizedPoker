const Joi = require('joi');
const {objectId} = require('./custom.validation');

const loginAdmin = {
  body: Joi.object().keys({
    email: Joi.string()
      .required()
      .email()
      .trim()
      .messages({
        'string.email': 'Please provide a valid email address',
        'any.required': 'Email is required',
      }),
    password: Joi.string()
      .required()
      .messages({
        'any.required': 'Password is required',
      }),
  }),
};

const forgotPassword = {
  body: Joi.object().keys({
    email: Joi.string()
      .required()
      .email()
      .trim()
      .messages({
        'string.email': 'Please provide a valid email address',
        'any.required': 'Email is required',
      }),
  }),
};

const resetPassword = {
  body: Joi.object().keys({
    token: Joi.string()
      .required()
      .messages({
        'any.required': 'Reset token is required',
      }),
    newPassword: Joi.string()
      .required()
      .min(8)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/)
      .messages({
        'string.min': 'Password must be at least 8 characters long',
        'string.pattern.base': 'Password must contain at least one letter, one number, and one special character',
        'any.required': 'New password is required',
      }),
  }),
};

const changePassword = {
  body: Joi.object().keys({
    oldPassword: Joi.string()
      .required()
      .messages({
        'any.required': 'Current password is required',
      }),
    newPassword: Joi.string()
      .required()
      .min(8)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/)
      .messages({
        'string.min': 'Password must be at least 8 characters long',
        'string.pattern.base': 'Password must contain at least one letter, one number, and one special character',
        'any.required': 'New password is required',
      }),
  }),
};

const updateTableType = {
  params: Joi.object().keys({
    id: Joi.string().required(),
  }),
  body: Joi.object()
    .keys({
      tableName: Joi.string(),
      minBuyIn: Joi.number().min(0),
      maxBuyIn: Joi.number().min(Joi.ref('minBuyIn')),
      smallBlind: Joi.number()
        .min(0)
        .max(Joi.ref('minBuyIn'))
        .messages({
          'number.min': 'Small blind cannot be negative',
          'number.max': 'Small blind cannot be greater than minimum buy-in',
        }),
      bigBlind: Joi.number()
        .min(Joi.ref('smallBlind'))
        .max(Joi.ref('minBuyIn'))
        .messages({
          'number.min': 'Big blind must be greater than or equal to small blind',
          'number.max': 'Big blind cannot be greater than minimum buy-in',
        }),
      status: Joi.string().valid('active', 'inactive'),
    })
    .with('smallBlind', 'bigBlind') // If smallBlind is provided, bigBlind must also be provided
    .with('bigBlind', 'smallBlind'), // If bigBlind is provided, smallBlind must also be provided
};

const addTableType = {
  body: Joi.object().keys({
    tableName: Joi.string()
      .required()
      .messages({
        'any.required': 'Table name is required',
      }),
    minBuyIn: Joi.number()
      .required()
      .min(0)
      .messages({
        'any.required': 'Minimum buy-in is required',
        'number.min': 'Minimum buy-in cannot be negative',
      }),
    maxBuyIn: Joi.number()
      .required()
      .min(Joi.ref('minBuyIn'))
      .messages({
        'any.required': 'Maximum buy-in is required',
        'number.min': 'Maximum buy-in must be greater than minimum buy-in',
      }),
    smallBlind: Joi.number()
      .required()
      .min(0)
      .max(Joi.ref('minBuyIn'))
      .messages({
        'any.required': 'Small blind is required',
        'number.min': 'Small blind cannot be negative',
        'number.max': 'Small blind cannot be greater than minimum buy-in',
      }),
    bigBlind: Joi.number()
      .required()
      .min(Joi.ref('smallBlind'))
      .max(Joi.ref('minBuyIn'))
      .messages({
        'any.required': 'Big blind is required',
        'number.min': 'Big blind must be greater than or equal to small blind',
        'number.max': 'Big blind cannot be greater than minimum buy-in',
      }),
  }),
};

module.exports = {
  loginAdmin,
  forgotPassword,
  resetPassword,
  changePassword,
  updateTableType,
  addTableType,
};
