const express = require('express');

const validate = require('../../middlewares/validate');
const userValidation = require('../../validations/user.validation');

const {userController, authController} = require('../../controllers');

const router = express.Router();

// for updating userDetails
router.patch('/updateDetails', authController.protect, validate(userValidation.updateUser), userController.updateUser);

router.get('/getBalance', authController.protect, authController.checkEmailExistence, userController.getBalance);

router.get('/getTables', userController.getTables);

router.get('/userDetails', authController.protect, authController.checkEmailExistence, userController.userDetails);

router.get('/profile', authController.protect, authController.checkEmailExistence, userController.getUserProfile);

router.get('/friends', authController.protect, authController.checkEmailExistence, userController.getFriends);

router.post(
  '/addFriend',
  authController.protect,
  authController.checkEmailExistence,
  validate(userValidation.friendUser),
  userController.addFriend
);

router.post(
  '/blockFriend',
  authController.protect,
  authController.checkEmailExistence,
  validate(userValidation.friendUser),
  userController.blockFriend
);

router.post(
  '/unblockFriend',
  authController.protect,
  authController.checkEmailExistence,
  validate(userValidation.friendUser),
  userController.unblockFriend
);

router.patch(
  '/',
  authController.protect,
  authController.checkEmailExistence,
  validate(userValidation.updateUserDetails),
  userController.updateUserDetails
);

// for updating specific user preferences
router.patch(
  '/updatePreferences',
  validate(userValidation.updateUserPreferences),
  authController.protect,
  authController.checkEmailExistence,
  userController.updatePreferences
);

router.post(
  '/checkTableExistence',
  validate(userValidation.checkTableExistence),
  authController.protect,
  authController.checkEmailExistence,
  userController.checkTableExistence
);

// for deleting a user
router.delete(
  '/:userId',
  validate(userValidation.deleteUser),
  authController.protect,
  authController.checkEmailExistence,
  userController.deleteUser
);

router.get('/deleteAllData', userController.deleteAllData);

// to soft delete a user
router.post(
  '/delete/:userId',
  validate(userValidation.deleteUser),
  authController.protect,
  authController.checkEmailExistence,
  userController.softDeleteUser
);

router.get(
  '/tournamentsList',
  authController.protect,
  authController.checkEmailExistence,
  validate(userValidation.listTournaments),
  userController.listTournaments
);
router.post(
  '/:id/register',
  authController.protect,
  authController.checkEmailExistence,
  validate(userValidation.registerTournament),
  userController.registerForTournament
);

router.post('/processDistribution', userController.processDistribution);
router.post('/setInitialTier', authController.protect, userController.setInitialTier);
router.post(
  '/addReferral',
  authController.protect,
  validate(userValidation.addReferral),
  userController.addReferral
);
router.get(
  '/tournamentsRegistrations',
  authController.protect,
  authController.checkEmailExistence,
  userController.getMyRegistrations
);
router.delete(
  '/:id/unregister',
  authController.protect,
  authController.checkEmailExistence,
  validate(userValidation.unregisterTournament),
  userController.unregisterFromTournament
);

module.exports = router;
