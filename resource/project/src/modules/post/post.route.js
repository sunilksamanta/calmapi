'use strict';
const PostController = require( './post.controller' );
const express = require( 'express' );
const router = express.Router();

router.get( '/', PostController.getAll );
router.get( '/:id', PostController.get );
router.post( '/', PostController.insert );
router.put( '/:id', PostController.update );
router.delete( '/:id', PostController.delete );


module.exports = router;
