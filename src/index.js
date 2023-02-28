const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const appEnv = process.env.NODE_ENV || 'development';
const tableName = process.env.APP_TABLE_NAME || `serverless-todo-${appEnv}`;
const sqsQueueUrl = process.env.APP_SQS_URL;

const ddbclient = new DynamoDBClient({ region: process.env.APP_REGION || 'ap-southeast-1' });
const ssmclient = new SSMClient({ region: process.env.APP_REGION || 'ap-southeast-1' });
const sqsclient = new SQSClient({ region: process.env.APP_REGION || 'ap-southeast-1' });

const parameterStoreJwtSecretName = process.env.APP_PARAMSTORE_JWT_SECRET_NAME;
const passwordOptions = {
  iteration: 1000,
  length: 64,
  digest: 'sha512'
};

// Middleware to validate application/json content-type
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.headers['content-type'] && req.headers['content-type'].indexOf('application/json') === -1) {
    return res.status(400).json({ error: 'Invalid Content-Type' });
  }
  
  next();
});

app.use(express.json());

// Get parameter from System Parameter Store
// Improvement: implements cache TTL
async function getParameterStore(name)
{
  const inputParameter = {
    Name: name,
    WithDecryption: true
  };
  const response = await ssmclient.send(new GetParameterCommand(inputParameter));
  return response.Parameter.Value;
}

// Middleware for JWT authentication
const authMiddleware = async (req, res, next) => {
  // Get token from authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).send({ message: 'Unauthorized' });
  }
  // Verify token with secret key
  try {
    const secretKey = await getParameterStore(parameterStoreJwtSecretName);
    const decoded = jwt.verify(token, secretKey);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).send({ message: 'Unauthorized' });
  }
};

// Send welcome email to user who just registered
async function sendWelcomeEmail(username)
{
  const queueResponse = await sqsclient.send(new SendMessageCommand({
    QueueUrl: sqsQueueUrl,
    MessageBody: JSON.stringify(({ username: username }))
  }));
  
  console.log('queueResponse', queueResponse);
}

// Route for registering a user
app.post('/register', async (req, res) => {
  const required = ['username', 'password', 'fullname', 'email'];
  for (const field of required) {
    if (req.body.hasOwnProperty(field) === false) {
      return res.status(400).json({ message: `Missing "${field}" attribute` });
    }
    
    if (req.body[field].length < 3) {
      return res.status(400).json({ message: `Value of "${field}" is too short` });
    }
  }
  const { username, password, email, fullname } = req.body;
  
  const existingUserParam = {
      TableName: tableName,
      Key: marshall({
          pk: `user#${username}`,
          sk: `user`
      })
  };
  
  const existingUserResponse = await ddbclient.send(new GetItemCommand(existingUserParam));
  
  if (existingUserResponse.Item !== undefined) {
    return res.status(400).json({ message: 'Username already taken' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hashedPassword = crypto.pbkdf2Sync(password, salt, 
                            passwordOptions.iteration, passwordOptions.length, passwordOptions.digest
                          ).toString('hex');
  const createdAt = new Date().toISOString();
  
  const user = { username, password: hashedPassword, salt, fullname, email };
  const userItem = {
    pk: `user#${username}`,
    sk: 'user',
    data: user,
    created_at: createdAt
  };
  const userItemParam = {
    TableName: tableName,
    Item: marshall(userItem)
  };
  await ddbclient.send(new PutItemCommand(userItemParam));
  
  // Send welcome email via queue
  await sendWelcomeEmail(username);
  
  // Send success message
  res.status(201).json({ message: 'User registered successfully' });
});

// Route for logging in a user
app.post('/login', async (req, res) => {

  const { username, password } = req.body;
  
  const existingUserParam = {
      TableName: tableName,
      Key: marshall({
          pk: `user#${username}`,
          sk: `user`
      })
  };
  
  const existingUserResponse = await ddbclient.send(new GetItemCommand(existingUserParam));
  
  if (existingUserResponse.Item === undefined) {
    return res.status(401).json({ message: 'Invalid username or password' });
  }
  const userItem = unmarshall(existingUserResponse.Item);
  const hashedPassword = crypto.pbkdf2Sync(password, userItem.data.salt, 
                            passwordOptions.iteration, passwordOptions.length, passwordOptions.digest
                          ).toString('hex');
                          
  if (hashedPassword !== userItem.data.password) {
    return res.status(401).send('Invalid username or password');
  }

  const secretKey = await getParameterStore(parameterStoreJwtSecretName);
  const token = jwt.sign({ 
    username, // it also automatically create attribute called 'username'
    email: userItem.data.email,
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 12)
  }, secretKey);

  res.json({ token });
});

// A test route that requires authentication
app.get('/protected', authMiddleware, (req, res) => {
  res.send(`Hello ${req.user.username}!`);
});

app.get('/todos/:id', authMiddleware, async (req, res, next) => {
  if (! req.params.id) {
    res.json([]);
    return;
  }
  
  try {
    let data = [];
    const itemParam = {
      TableName: tableName,
      Key: marshall({
        pk: `todo#${req.params.id}`,
        sk: `todo-${req.user.username}`
      })
    };
    
    const itemResponse = await ddbclient.send(new GetItemCommand(itemParam));
    if (itemResponse.Item !== undefined) {
      let item = unmarshall(itemResponse.Item);
      data = item.data;
    }
    
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.put('/todos/:id', authMiddleware, (req, res) => {
  if (! req.params.id) {
    res.status(400).json({
      message: "Bad request: Missing todo id."
    });
    
    return;
  }
  
  const todoItem = {
    pk: `todo#${req.params.id}`,
    sk: 'todo-' + req.user.username,
    data: req.body
  };
  
  const todoItemParam = {
    TableName: tableName,
    Item: marshall(todoItem)
  };
  
  ddbclient.send(new PutItemCommand(todoItemParam));
  
  console.log(req.body);
  res.json({
    "message": "Todo successfully added"
  });
});

// Custom error handler function to handle JSON parsing errors
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  
  if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON data' });
  }
  
  res.status(500).json({ message: err.toString() });
});

process.on('unhandledRejection', function(err) {
  console.log(err.stack);
});

module.exports = app;

// See local.js to run this script locally
// const port = process.env.APP_PORT || 8080;

// app.listen(port, function() {
//   console.log(`API server running on port ${port}`);
// });
