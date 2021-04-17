'use strict';
const UserController = require( './user.controller' );
const express = require( 'express' ),
    router = express.Router();
const AuthController = require( '../auth/auth.controller' );

router.put( '/', AuthController.checkLogin, UserController.update );
router.get( '/my-profile', AuthController.checkLogin, UserController.get );


module.exports = router;
