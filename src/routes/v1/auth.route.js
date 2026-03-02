const express = require('express');
const validate = require('../../middlewares/validate');
const {authValidation} = require('../../validations');
const {authController} = require('../../controllers');
const router = express.Router();
router.post('/login', validate(authValidation.login), authController.loginUser);
router.post('/registration', validate(authValidation.registration), authController.registration);
router.post('/userVerification',validate(authValidation.userVerification), authController.userVerification);
module.exports = router;
