'use strict';
const AuthController = require( './auth.controller' );
const express = require( 'express' ),
    router = express.Router();

router.post( '/login', AuthController.login );
router.delete( '/logout', AuthController.checkLogin, AuthController.logout );

router.post( '/register', AuthController.register );

router.post( '/change-password', AuthController.checkLogin, AuthController.changePassword );
router.post( '/request-password-reset', AuthController.requestPasswordReset );

router.post( '/password-reset', AuthController.resetPassword );

router.get( '/profile', AuthController.checkLogin, AuthController.getProfile );
router.put( '/profile', AuthController.checkLogin, AuthController.updateProfile );

module.exports = router;
