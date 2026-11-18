'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the sosbuddy folder as static files
app.use('/sosbuddy', express.static(path.join(__dirname, 'sosbuddy')));

// Root URL goes directly to SOS Buddy (User App)
app.get('/', (req, res) => {
  res.redirect('/sosbuddy/index.html');
});

app.listen(PORT, () => {
  console.log(`SOS Buddy frontend running on port ${PORT}`);
});