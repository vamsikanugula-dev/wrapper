const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

// Create S3 client using Access Point
// Parse the ARN to get access point name and account ID for endpoint construction
const accessPointArn = process.env.AWS_S3_ACCESS_POINT_ARN;
// ARN format: arn:aws:s3:region:account-id:accesspoint/access-point-name
const arnParts = accessPointArn.split(':');
const accessPointNameWithPrefix = arnParts[arnParts.length - 1]; // Get the access point name with prefix (after last colon)
const accessPointName = accessPointNameWithPrefix.split('/')[1]; // Extract just the access point name
const accountId = arnParts[4]; // Account ID is at index 4
const endpoint = `https://${accessPointName}-${accountId}.s3-accesspoint.${process.env.AWS_REGION}.amazonaws.com`;

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: endpoint
});

/**
 * Generate a presigned PUT URL for uploading a file to S3 via Access Point
 * @param {string} key - The S3 object key (filename)
 * @param {string} contentType - MIME type of the file
 * @param {number} expiresIn - URL expiration time in seconds (default: 900)
 * @returns {Promise<string>} - Presigned PUT URL
 */
async function getPutObjectUrl(key, contentType, expiresIn = 900) {
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_ACCESS_POINT_ARN, // Using Access Point ARN as the bucket
    Key: key,
    ContentType: contentType
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generate a presigned GET URL for downloading a file from S3 via Access Point
 * @param {string} key - The S3 object key (filename)
 * @param {number} expiresIn - URL expiration time in seconds (default: 900)
 * @returns {Promise<string>} - Presigned GET URL
 */
async function getObjectUrl(key, expiresIn = 900) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_S3_ACCESS_POINT_ARN, // Using Access Point ARN as the bucket
    Key: key
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Delete an object from S3 via Access Point
 * @param {string} key - The S3 object key (filename)
 * @returns {Promise<void>}
 */
async function deleteObject(key) {
  const command = new DeleteObjectCommand({
    Bucket: process.env.AWS_S3_ACCESS_POINT_ALIAS, // Using Access Point alias as the bucket
    Key: key
  });

  await s3Client.send(command);
}

/**
 * Upload a file buffer to S3 via Access Point
 * @param {Buffer} buffer - File data as Buffer
 * @param {string} key - The S3 object key (filename)
 * @param {string} contentType - MIME type of the file
 * @returns {Promise<void>}
 */
async function uploadFile(buffer, key, contentType) {
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_ACCESS_POINT_ALIAS, // Using Access Point alias as the bucket
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3Client.send(command);
}

/**
 * Download a file from S3 via Access Point
 * @param {string} key - The S3 object key (filename)
 * @returns {Promise<Buffer>} - File data as Buffer
 */
async function downloadFile(key) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_S3_ACCESS_POINT_ARN, // Using Access Point ARN as the bucket
    Key: key
  });

  const response = await s3Client.send(command);
  // Convert stream to buffer
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = {
  s3Client,
  getPutObjectUrl,
  getObjectUrl,
  deleteObject,
  uploadFile,
  downloadFile
};