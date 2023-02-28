#!/bin/sh

[ ! -f "./lambda.js" ] && {
    echo "Missing lambda.js file, make sure you're in project root folder." >&2
    exit 1
}

APP_NAME=serverless-todo-api
ZIP_FILE_NAME=${APP_NAME}.zip
FILES_TO_ZIP="src/ node_modules/ lambda.js"
SOURCE_FILES="src package.json package-lock.json lambda.js"

# Zip file will be uploaded to this bucket
[ -z "$APP_FUNCTION_BUCKET" ] && {
    echo "Missing APP_FUNCTION_BUCKET" 2>&1
    exit 1
}

rm -rf .build/tmp/ 2>/dev/null

echo "Downloading app dependencies..."
mkdir -p .build/tmp
cp -a $SOURCE_FILES .build/tmp/
cd .build/tmp && npm install --omit=dev

echo "Creating zip..."
zip -q -r $ZIP_FILE_NAME $FILES_TO_ZIP

cd ../..

echo "Uploading zip to S3 Bucket..."
aws s3 cp .build/tmp/$ZIP_FILE_NAME s3://$APP_FUNCTION_BUCKET/$ZIP_FILE_NAME