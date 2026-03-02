const { authService, userService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { ethers } = require('ethers');
const randomstring = require('randomstring');
const config = require('../config/config');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const { abi: polygonTokenContractABI } = require('./MyToken.json');
const MasterPokerFactoryABI = require('../blockchain/masterpokertable.json').abi;
const mongoHelper = require('../models/customdb');

const generateNonceMessage = walletAddress => `
  Welcome to Poker.
  Click to sign in.
  This request will not trigger a blockchain transaction or cost any gas fees.
  Your authentication status will reset after 24 hours.
  Wallet Address: ${walletAddress}.
  Nonce: ${randomstring.generate(12)}
`;

const loginUser = catchAsync(async (req, res) => {
  try {
    const { walletAddress, signature, consent } = req.body;

    // Find user using mongoHelper
    const userResult = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, { walletAddress: walletAddress });
    console.log('🚀 ~ loginUser ~ userResult:', userResult);

    if (userResult.data.length === 0) {
      return res.status(404).send({ status: false, error: 'User not found or wallet address wrong' });
    }

    const user = userResult.data[0];

    if (user.isBlocked) {
      return res.status(403).send({ status: false, error: 'Your account has been blocked. Please contact admin' });
    }

    // Normalize signature to handle non-canonical s values
    let normalizedSignature = signature;
    try {
      const sig = ethers.Signature.from(signature);
      normalizedSignature = sig.serialized;
    } catch (sigError) {
      console.log('Signature normalization not needed or failed:', sigError.message);
    }

    const signerAddr = ethers.verifyMessage(user.nonce_message, normalizedSignature);
    if (signerAddr.toLowerCase() !== walletAddress.toLowerCase()) {
      const message = generateNonceMessage(walletAddress);

      // Update user using mongoHelper
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.USERS,
        user._id,
        { nonce_message: message },
        mongoHelper.MODELS.USER
      );

      return res.status(401).send({ status: false, error: 'User not authenticated' });
    }

    const token = signToken(user._id);
    const message = generateNonceMessage(walletAddress);

    // Update user with new nonce and consent
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      user._id,
      {
        nonce_message: message,
        consent: consent,
      },
      mongoHelper.MODELS.USER
    );

    const polygonProvider = new ethers.JsonRpcProvider(config.POLYGON_URL);
    let tokenContractAddress = config.USDT_TOKEN;
    const contract = new ethers.Contract(tokenContractAddress, polygonTokenContractABI, polygonProvider);
    const balance = (await contract.balanceOf(walletAddress)).toString();

    return res.status(200).send({
      status: true,
      message: 'User token',
      data: {
        token,
        username: user.username,
        balance: ethers.formatUnits(balance, 6),
        profilePic : user.profilePic,
        dob : user.dob,
        username : user.username,
        accountType : user.accountType,
        handsFromNextTier : user.handsFromNextTier,
        reputation : user.reputation,
        tier : user.tier,
        recruits : user.recruits
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ status: false, error: error.message });
  }
});

const userVerification = catchAsync(async (req, res) => {
  try {
    const { walletAddress, platform, referralCode } = req.body;

    // Find user using mongoHelper
    let userResult = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, { walletAddress: walletAddress });
    console.log(userResult, "before ")
    userResult = userResult.data[0];
    const message = generateNonceMessage(walletAddress);
    console.log(userResult, "in verification");
    if (userResult) {
      // User exists, update nonce message
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.USERS,
        userResult._id,
        { nonce_message: message },
        mongoHelper.MODELS.USER
      );
    } else {
      // User doesn't exist, create new user
      const shortWalletAddress = `${walletAddress.substring(0, 5)}....${walletAddress.substring(33, 43)}`;
      const userJson = {
        walletAddress,
        nonce_message: message,
        username: await generateUniqueUsername(),
        referralCode: await generateUniqueReferralCode(),
        shortWalletAddress,
        platform,
      };
      console.log('creating new user');
      const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.USERS, userJson, mongoHelper.MODELS.USER);

      // Handle referral if provided
      if (referralCode && createResult.success) {
        const recruitEarningsService = require('../services/recruitEarnings.service');
        await recruitEarningsService.addRecruit(createResult.data._id, referralCode);
      }
    }

    res.send({ status: true, message: 'Nonce message', data: message });
  } catch (error) {
    console.error(error);
    res.status(500).send({ status: false, error: error.message });
  }
});

const adjectives = [
  'Sly',
  'Bold',
  'Jolly',
  'Calm',
  'Swift',
  'Brave',
  'Keen',
  'Witty',
  'Loyal',
  'Merry',
  'Wild',
  'Quick',
  'Shy',
  'Lucky',
  'Bright',
  'Quiet',
  'Proud',
  'Zesty',
  'Crafty',
  'Smooth',
  'Feisty',
  'Happy',
  'Noble',
  'Daring',
  'Gentle',
  'Curious',
  'Steady',
  'Vigilant',
  'Clever',
  'Cheerful',
  'Fierce',
  'Sassy',
  'Sturdy',
  'Dashing',
  'Plucky',
  'Spry',
  'Grumpy',
  'Dazzling',
  'Breezy',
  'Mighty',
  'Nimble',
  'Radiant',
  'Gallant',
  'Jumpy',
  'Wise',
  'Sunny',
  'Snappy',
  'Charming',
  'Gritty',
  'Hasty',
  'Lively',
  'Eager',
  'Sneaky',
  'Bouncy',
  'Perky',
  'Peppy',
  'Tidy',
  'Zany',
  'Thrifty',
  'Brisk',
  'Whizzy',
  'Wiry',
  'Dapper',
  'Zippy',
  'Lush',
  'Frisky',
  'Smiley',
  'Fearless',
  'Peppy',
  'Nifty',
  'Bubbly',
  'Grim',
  'Stout',
  'Whimsical',
  'Flashy',
  'Jazzy',
  'Giddy',
  'Bashful',
  'Savvy',
  'Crisp',
  'Lanky',
  'Scrappy',
  'Spunky',
  'Chirpy',
  'Buzzing',
  'Gracious',
  'Playful',
  'Zippy',
  'Punky',
  'Silly',
  'Coy',
  'Sprightly',
  'Brisk',
  'Rowdy',
  'Speedy',
  'Energetic',
  'Gleeful',
  'Gutsy',
  'Zappy',
  'Thrifty',
  'Shiny',
  'Hearty',
  'Snug',
  'Pithy',
];

const nouns = [
  'Dragon',
  'Phoenix',
  'Titan',
  'Valkyrie',
  'Wizard',
  'Elf',
  'Dwarf',
  'Goblin',
  'Cyclops',
  'Gryphon',
  'Unicorn',
  'Sphinx',
  'Troll',
  'Golem',
  'Pegasus',
  'Kraken',
  'Mermaid',
  'Basilisk',
  'Djinn',
  'Vampire',
  'Werewolf',
  'Nymph',
  'Centaur',
  'Chimera',
  'Hydra',
  'Minotaur',
  'Fairy',
  'Imp',
  'Witch',
  'Sorcerer',
  'Warlock',
  'Orc',
  'Zombie',
  'Ghoul',
  'Banshee',
  'Lich',
  'Ogre',
  'Wraith',
  'Demon',
  'Angel',
  'Alien',
  'Robot',
  'Cyborg',
  'Spaceship',
  'Asteroid',
  'Android',
  'TimeTraveler',
  'Starship',
  'Mech',
  'Mutant',
  'Sentinel',
  'Guardian',
  'Paladin',
  'Necromancer',
  'Ranger',
  'Knight',
  'Assassin',
  'Samurai',
  'Ninja',
  'Pirate',
  'Barbarian',
  'Gladiator',
  'Viking',
  'Rogue',
  'Monk',
  'Mage',
  'Alchemist',
  'Archer',
  'Bard',
  'Crusader',
  'Cleric',
  'Druid',
  'Enchanter',
  'Illusionist',
  'Jester',
  'Champion',
  'Warden',
  'Shapeshifter',
  'Berserker',
  'Behemoth',
  'Titan',
  'Archon',
  'Phantom',
  'Specter',
  'Shade',
  'Avatar',
  'Reaper',
  'Executioner',
  'Seer',
  'Oracle',
  'Prophet',
  'Mystic',
  'Thief',
  'Siren',
  'Harpy',
  'Elemental',
  'Beholder',
  'Spartan',
  'Templar',
  'Nomad',
  'Sorceress',
  'Warrior',
  'Commander',
  'Conqueror',
];

async function generateUniqueUsername() {
  let username;
  let isTaken = true;

  while (isTaken) {
    const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    username = `${randomAdjective.toLowerCase()}${randomNoun.toLowerCase()}`;

    if (username.length > 9) {
      username = username.slice(0, 9);
    } else if (username.length < 7) {
      username = `${randomAdjective.toLowerCase()}${randomNoun.toLowerCase()}`.slice(0, 9);
    }

    // Check if username exists using mongoHelper
    const userExistsResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USERS, 'username', username);

    isTaken = userExistsResult.success && userExistsResult.data;
  }

  return username;
}

async function generateUniqueReferralCode() {
  let referralCode;
  let isTaken = true;

  while (isTaken) {
    referralCode = randomstring.generate({ length: 8, charset: 'alphanumeric', capitalization: 'uppercase' });
    const result = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USERS, 'referralCode', referralCode);
    isTaken = result.success && result.data;
  }

  return referralCode;
}

const registration = catchAsync(async (req, res) => {
  try {
    const { walletAddress, signature, consent } = req.body;

    // Check if user already exists
    const userResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USERS, 'walletAddress', walletAddress);

    if (userResult.success && userResult.data) {
      return res.status(404).send({ status: false, error: 'User already registered, kindly login' });
    }

    const message = generateNonceMessage(walletAddress);
    const shortWalletAddress = `${walletAddress.substring(0, 5)}....${walletAddress.substring(33, 43)}`;
    const userJson = {
      walletAddress,
      nonce_message: message,
      username: uuidv4(),
      shortWalletAddress,
    };

    // Create new user using mongoHelper
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.USERS, userJson, mongoHelper.MODELS.USER);

    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    const newUser = createResult.data;
    const token = signToken(newUser._id);

    res.send({ status: true, message: 'Nonce message', data: { message, token } });
  } catch (error) {
    console.error(error);
    res.status(500).send({ status: false, error: error.message });
  }
});

const protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        status: false,
        error: 'You are not logged in! Please log in to get access.',
      });
    }

    const decoded = await promisify(jwt.verify)(token, config.JWT_SECRET);

    // Find current user using mongoHelper
    const currentUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, decoded.id);
    console.log(currentUserResult, "currentUserResult");
    if (!currentUserResult.success || !currentUserResult.data) {
      return res.status(401).json({
        status: false,
        msg: 'The user belonging to this token does no longer exist.',
      });
    }

    const currentUser = currentUserResult.data;

    // Check if user is blocked
    if (currentUser.isBlocked) {
      return res.status(403).json({
        status: false,
        error: 'Your account has been blocked. Please contact support.',
      });
    }

    req.user = currentUser;
    next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({
      status: false,
      error: err.message,
    });
  }
};

const checkEmailExistence = async (req, res, next) => {
  try {
    // User will be available from the protect middleware
    const user = req.user;

    // Check if email exists
    if (!user.email) {
      return res.status(429).json({
        status: false,
        error: 'Email is required. Please update your profile before proceeding.',
      });
    }

    next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: false,
      error: 'Error checking email existence',
    });
  }
};
const signToken = id => {
  return jwt.sign({ id }, config.JWT_SECRET);
};
module.exports = {
  loginUser,
  userVerification,
  protect,
  registration,
  checkEmailExistence,
};
