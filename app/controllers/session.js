
/*!
 * Module dependencies.
 */

var _ = require('lodash');
var mongoose = require('mongoose');
var Session = mongoose.model('Notebook');
var multiparty = require('multiparty');
var knox = require('knox');
var randomstring = require('randomstring');
var path = require('path');
var easyimage = require('easyimage');
var async = require('async');


var s3Client = knox.createClient({
    secure: false,
    key: process.env.S3_KEY,
    secret: process.env.S3_SECRET,
    bucket: process.env.S3_BUCKET,
});


exports.index = function (req, res) {

    Session.find({}, null, {sort: {createdAt: -1}}, function(err, sessions) {

        res.render('session/index', {
            sessions: sessions
        });
    });
};


exports.feed = function (req, res, next) {

    var sessionId = req.params.sid;


    Session.findById(sessionId, function(err, session) {
        if(err) {
            return next(err);
        }

        res.render('session/feed', {
            session: session
        });
    });
};

exports.read = function (req, res, next) {

    var sessionId = req.params.sid;
    var vizId = req.params.vid;

    Session.findById(sessionId, function(err, session) {
        if(err) {
            return next(err);
        }

        var viz = _.find(session.visualizations, function (v) {
            return v.id === vizId;
        });

        res.render('session/visualization', {
            session: session,
            viz: viz
        });
    });
};


exports.create = function(req, res, next) {

    console.log('creating session');
    var session = new Session();
    session.save(function(err) {
        if(err) {
            return next(err);
        }
        return res.redirect('/sessions/' + session.id + '/feed/');
    });
};



exports.getNew = function(req, res, next) {

    console.log('creating session');
    var session = new Session();
    session.save(function(err) {
        if(err) {
            return next(err);
        }
        return res.redirect('/sessions/' + session.id + '/feed/');
    });
};



exports.addData = function (req, res, next) {
    var sessionId = req.params.sid;

    // var form = new multiparty.Form({
    //     autoFiles
    // });

    Session.findById(sessionId, function(err, session) {
        if(err) {
            return next(err);
        }

        if(req.is('json')) {

            console.log('finding session');
            if(err) {
                return next(err);
            }

            session.visualizations.push({data: req.body.data, type: req.body.type});
            var viz = session.visualizations[session.visualizations.length - 1];

            req.io.of('/sessions/' + sessionId)
                .emit('viz', viz);

            session.save(function(err) {
                if(err) {
                    return next(err);
                }

                return res.json(200);
            });

        } else {
            // console.log()
            var form = new multiparty.Form();
            form.parse(req, function(err, fields, files) {

                _.each(files, function(f) {
                    thumbnailAndUpload(f, sessionId, function(err, data) {

                        var imgData = data;

                        console.log(imgData);
                        session.visualizations.push({images: [imgData], type: 'image'});
                        viz = session.visualizations[session.visualizations.length - 1];

                        req.io.of('/sessions/' + sessionId)
                            .emit('viz', viz);

                        session.save(function(err) {
                            if(err) {
                                return next(err);
                            }
                            return res.json(200);
                        });
                    });
                });

            });

        }
    });

};




exports.addImage = function (req, res, next) {

    var sessionId = req.params.sid;
    var vizId = req.params.vid;

    Session.findById(sessionId, function(err, session) {
        if(err) {
            return next(err);
        }

        var viz = _.find(session.visualizations, function (v) {
            return v.id === vizId;
        });

        if(!viz) {
            next(404);
        }

        var form = new multiparty.Form();


        form.parse(req, function(err, fields, files) {
            _.each(files, function(f) {
                thumbnailAndUpload(f, sessionId, function(err, data) {

                    var imgData = data;


                    viz.images.push(imgData);

                    req.io.of('/sessions/' + sessionId)
                        .emit('update', {
                            vizId: viz._id, 
                            data: imgData
                        });

                    session.save(function(err) {
                        if(err) {
                            return next(err);
                        }
                        return res.json(200);
                    });
                });
            });
        });
    });
};


var thumbnailAndUpload = function(f, sessionId, callback) {

    var maxWidth = 500;
    var maxHeight = 500;

    // Image file info
    var imgPath = f[0].path;
    var extension = path.extname(imgPath).toLowerCase();
    var filenameWithoutExtension = path.basename(imgPath, extension);


    var thumbnailPath;

    if(process.env.NODE_ENV === 'production') {
        thumbnailPath = path.resolve(__dirname + '/../../'  + './tmp/' + filenameWithoutExtension + '_thumbnail' + extension);
    } else {
        thumbnailPath = path.dirname(imgPath) + filenameWithoutExtension + '_thumbnail' + extension;
    }
    

    // Upload paths for s3
    var uploadName = randomstring.generate();
    var destPath = '/sessions/' + sessionId + '/';
    var originalS3Path = destPath + uploadName;
    var thumbnailS3Path = destPath + uploadName + '_small';


    // s3 headers
    var headers = {
      'x-amz-acl': 'public-read',
    };
    if( extension === '.jpg' || extension === '.jpeg' ) {
        headers['Content-Type'] = 'image/jpeg';
    } else if (extension === '.png') {
        headers['Content-Type'] = 'image/png';
    }

    easyimage
        .info(imgPath)
        .then(function(file) {
            var thumbWidth;
            var thumbHeight;

            console.log('outputing to: ' + thumbnailPath);

            if(file.width > file.height) {
                thumbWidth = Math.min(maxWidth, file.width);
                thumbHeight = file.height * (thumbWidth / file.width);
            } else {
                thumbHeight = Math.min(maxHeight, file.height);
                thumbWidth = file.width * (thumbHeight / file.height);
            }

            return easyimage.resize({
                src: imgPath,
                dst: thumbnailPath,
                width: thumbWidth,
                height: thumbHeight
            });
        }).then(function() {
            var imgURL = 'https://s3.amazonaws.com/' + process.env.S3_BUCKET + originalS3Path;
            var thumbURL = 'https://s3.amazonaws.com/' + process.env.S3_BUCKET + thumbnailS3Path;

            var imgData = {
                original: imgURL,
                thumbnail: thumbURL
            };

            callback(null, imgData);
            async.parallel([
                function(callback) {
                    console.log(imgPath + ':' + originalS3Path);
                    s3Client.putFile(imgPath, originalS3Path, headers, callback);
                },
                function(callback) {
                    console.log(thumbnailPath + ':' + thumbnailS3Path);
                    s3Client.putFile(thumbnailPath, thumbnailS3Path, headers, callback);
                }
            ]);
        }, function(err) {
            console.log(err);
            callback(err);
        });
};