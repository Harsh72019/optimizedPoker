const Joi = require('joi');
const path = require('path');
const dotnev = require('dotenv');

dotnev.config({path: path.join(__dirname, '../../.env')});

// schema of env files for validation
const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string()
      .valid('test', 'development', 'production')
      .required(),
    PORT: Joi.number().default(8082),
    SOCKET_PORT: Joi.number().default(3000),
    MONGODB_URL: Joi.string().required(),
    JWT_SECRET: Joi.string().required(),
    POLYGON_URL: Joi.string().required(),
    MAILEROO_API_KEY: Joi.string().required(),
    MAILEROO_URL: Joi.string().required(),
    EMAIL_FROM: Joi.string().required(),
    FRONTEND_URL: Joi.string().required(),
    USDT_TOKEN: Joi.string().required(),
    PRIVATE_KEY: Joi.string().required(),
    MASTER_POKER_TABLE_CONTRACT: Joi.string().required(),
    WALLET_FACTORY_ADDRESS: Joi.string().required(),
    REDIS_HOST: Joi.string().required(),
    REDIS_PORT: Joi.number().default(6379),
    REDIS_PASSWORD: Joi.string().required(),
    MONGODB_API_URL: Joi.string().required(),
    MONGODB_URL : Joi.string().required(),
    CSRF_PASSWORD: Joi.string().required(),
  })
  .unknown();

// validating the process.env object that contains all the env variables
const {value: envVars, error} = envVarsSchema.prefs({errors: {label: 'key'}}).validate(process.env);

// throw error if the validation fails or results into false
if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

module.exports = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  SOCKET_PORT: envVars.SOCKET_PORT,
  JWT_SECRET: envVars.JWT_SECRET,
  POLYGON_URL: envVars.POLYGON_URL,
  FRONTEND_URL: envVars.FRONTEND_URL,
  MAILEROO_API_KEY: envVars.MAILEROO_API_KEY,
  EMAIL_FROM: envVars.EMAIL_FROM,
  MAILEROO_URL: envVars.MAILEROO_URL,
  USDT_TOKEN: envVars.USDT_TOKEN,
  PRIVATE_KEY: envVars.PRIVATE_KEY,
  MASTER_POKER_TABLE_CONTRACT: envVars.MASTER_POKER_TABLE_CONTRACT,
  WALLET_FACTORY_ADDRESS: envVars.WALLET_FACTORY_ADDRESS,
  REDIS_HOST: envVars.REDIS_HOST,
  REDIS_PORT: envVars.REDIS_PORT,
  REDIS_PASSWORD: envVars.REDIS_PASSWORD,
  MONGODB_API_URL: envVars.MONGODB_API_URL,
  MONGO_URI : envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
  CSRF_PASSWORD: envVars.CSRF_PASSWORD,
  mongoose: {
    url: envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 50,        // ✅ Increase connection pool for better performance
      minPoolSize: 10,        // ✅ Maintain minimum connections
      socketTimeoutMS: 45000, // ✅ Socket timeout
      serverSelectionTimeoutMS: 5000, // ✅ Server selection timeout
    },
  },
};
