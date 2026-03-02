// admin.controller.js
const catchAsync = require('../utils/catchAsync');
const mongoHelper = require('../models/customdb');
const {adminService} = require('../services');
const {mailService} = require('../microservices');
const httpStatus = require('http-status');
const bcrypt = require('bcrypt');
const config = require('../config/config');
const jwt = require('jsonwebtoken');
const {promisify} = require('util');
const {v4: uuidv4} = require('uuid');
const {abi: polygonTokenContractABI} = require('./MyToken.json');
const {getPaginateConfig} = require('../utils/queryPHandler');

const toBase64 = value => {
  return Buffer.from(value.toString()).toString('base64');
};

const fromBase64 = base64Value => {
  return Buffer.from(base64Value, 'base64').toString('utf8');
};

const signToken = id => {
  return jwt.sign({id}, config.JWT_SECRET);
};

const login = catchAsync(async (req, res) => {
  try {
    const {email, password} = req.body;
    const admin = await adminService.loginAdmin(email, password);
    const token = signToken(admin._id);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Login successful',
      data: {token},
    });
  } catch (error) {
    res.status(httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const forgotPassword = catchAsync(async (req, res) => {
  try {
    const {email} = req.body;
    const admin = await adminService.getAdminByEmail(email);

    const resetToken = toBase64(`${admin.id}.${Date.now()}`);
    const resetLink = `${config.FRONTEND_URL}/reset-password?token=${resetToken}`;

    const emailData = {
      to: email,
      subject: 'Reset Password Request',
      html: `Click here to reset your password: <a href="${resetLink}">Reset Password</a>`,
    };

    await mailService.sendEmail(emailData);
    await adminService.updateAdminById(admin.id, {reset_token: resetToken});

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Password reset link sent successfully',
    });
  } catch (error) {
    res.status(httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const userList = catchAsync(async (req, res) => {
  try {
    const {keyword, isBlocked, ...otherOptions} = req.query;
    const options = getPaginateConfig(otherOptions);
    console.log('🚀 ~ userList ~ options:', options);
    const data = await adminService.listOfUsers(keyword, isBlocked, options);
    res.status(httpStatus.OK).json({status: true, data});
  } catch (error) {
    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({status: false, message: `Failed to fetch users list: ${error}`});
  }
});

const viewUser = catchAsync(async (req, res) => {
  try {
    const {id} = req.params;
    const data = await adminService.viewUser(id);
    res.status(httpStatus.OK).json({status: true, data});
  } catch (error) {
    res.status(httpStatus.INTERNAL_SERVER_ERROR).json({status: false, message: `Failed to fetch users list: ${error}`});
  }
});

const resetPassword = catchAsync(async (req, res) => {
  try {
    const {token, newPassword} = req.body;
    const decodedToken = fromBase64(token);
    const [id, timestamp] = decodedToken.split('.');

    const admin = await adminService.getAdminById(id);
    if (!admin || admin.reset_token !== token) {
      throw new Error('Invalid or expired token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await adminService.updateAdminById(id, {
      password: hashedPassword,
      reset_token: null,
    });

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Password reset successful',
    });
  } catch (error) {
    res.status(httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
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
    console.log("here in the protext");
    const currentUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.ADMINS, decoded.id);
    console.log("🚀 ~ protect ~ currentUserResult:", currentUserResult);
    // if (!currentUserResult.success || !currentUserResult.data) {
    //   return res.status(401).json({
    //     status: false,
    //     msg: 'The admin belonging to this token does no longer exist.',
    //   });
    // }

    req.admin = currentUserResult.data;
    next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({
      status: false,
      error: err.message,
    });
  }
};

const blockUnblockUser = catchAsync(async (req, res) => {
  try {
    const userId = req.params.id;
    const result = await adminService.toggleUserBlock(userId);

    res.status(httpStatus.OK).json({
      status: true,
      message: `User ${result.status} successfully`,
      data: result,
    });
  } catch (error) {
    res.status(httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const getArchivedTables = catchAsync(async (req, res) => {
  try {
    const {options} = getPaginateConfig(req.query);
    const result = await adminService.getArchivedTables(options);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Archived tables fetched successfully',
      data: result,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const getArchivedTableById = catchAsync(async (req, res) => {
  try {
    const {id} = req.params;
    const archivedTable = await adminService.getArchivedTableById(id);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Archived table fetched successfully',
      data: archivedTable,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const changePassword = catchAsync(async (req, res) => {
  try {
    const {oldPassword, newPassword} = req.body;
    const adminId = req.admin.id; // From protect middleware

    const admin = await adminService.changePassword(adminId, oldPassword, newPassword);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Password updated successfully',
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const getTableTypes = catchAsync(async (req, res) => {
  try {
    const {options} = getPaginateConfig(req.query);
    const result = await adminService.getTableTypes(req.query.status, options);

    res.status(httpStatus.OK).json({
      status: true,
      message: 'Table types fetched successfully',
      data: result,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const getTableTypeById = catchAsync(async (req, res) => {
  try {
    const tableType = await adminService.getTableTypeById(req.params.id);
    res.status(httpStatus.OK).json({
      status: true,
      message: 'Table type fetched successfully',
      data: tableType,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const updateTableType = catchAsync(async (req, res) => {
  try {
    const tableType = await adminService.updateTableType(req.params.id, req.body);
    res.status(httpStatus.OK).json({
      status: true,
      message: 'Table type updated successfully',
      data: tableType,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const deleteTableType = catchAsync(async (req, res) => {
  try {
    await adminService.deleteTableType(req.params.id);
    res.status(httpStatus.OK).json({
      status: true,
      message: 'Table type deleted successfully',
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const toggleTableTypeStatus = catchAsync(async (req, res) => {
  try {
    const tableType = await adminService.toggleTableTypeStatus(req.params.id);
    res.status(httpStatus.OK).json({
      status: true,
      message: `Table type ${tableType.status === 'active' ? 'activated' : 'deactivated'} successfully`,
      data: tableType,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});

const addTableType = catchAsync(async (req, res) => {
  try {
    const tableType = await adminService.addTableType(req.body);

    res.status(httpStatus.CREATED).json({
      status: true,
      message: 'Table type created successfully',
      data: tableType,
    });
  } catch (error) {
    res.status(error.statusCode || httpStatus.BAD_REQUEST).json({
      status: false,
      message: error.message,
    });
  }
});
module.exports = {
  login,
  forgotPassword,
  resetPassword,
  protect,
  userList,
  viewUser,
  blockUnblockUser,
  getArchivedTables,
  getArchivedTableById,
  changePassword,
  toggleTableTypeStatus,
  deleteTableType,
  getTableTypeById,
  getTableTypes,
  updateTableType,
  addTableType,
};
