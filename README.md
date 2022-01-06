# gulp-oss-sync
A gulp plugin to sync files with Aliyun OSS

Inspired by [gulp-awspublish](https://github.com/pgherveou/gulp-awspublish)

[![NPM](https://nodei.co/npm/gulp-oss-sync.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/gulp-oss-sync/)

## Introduction
Use local cache file to store last published file path and file hash. If the file is in the cache file and the hash is unchanged, then ignore this file.

## Screen shots
![screen shot](https://raw.githubusercontent.com/bigmurry/gulp-oss-sync/master/test/capture.jpeg)

## Features
- Use cache file to save network traffic
- Automatic delete useless file in OSS

## How to use

```js
const gulp = require('gulp');
const ossSync = require('gulp-oss-sync');

const ossConf = {
  connect: {
    "region": "<your oss region>",
    "accessKeyId": "<your access key id here>",
    "accessKeySecret": "<your access key secret kere>",
    "bucket": "<your bucket name here>"
  },
  controls: {
    "headers": {
      "Cache-Control": "no-cache"
    }
  },
  setting: {
    dir: "foo/bar", // root directory name
    noClean: false, // compare with the last cache file to decide if the file deletion is need
    force: false, // ignore cache file and force re-upload all the files
    quiet: true, // quiet option for oss deleteMulti operation
    fileName: (path)=> { return path } // modify oss file path
  }
};
const cacheConf = {
  cacheFileName: '.oss-cache-test' // the filename for the cache file
};

gulp.task('publish', function () {
  return gulp.src(['**/*.png'])
    .pipe(ossSync(ossConf, cacheConf));
})

```
