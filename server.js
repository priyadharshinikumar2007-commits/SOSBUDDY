'use strict';

const express = require('express');
const path = require('path');

const app = express();
// Railway automatically PORT env var-a set pannum
const PORT = process.env.PORT || 3000;

// unga sosbuddy folder-a static-a serve pannunga
app.use('/sosbuddy', express.static(path.join(__dirname, 'sosbuddy')));

// Default URL click panna, sosbuddy index.html-ku redirect aagum
app.get('/', (req, res) => {
  res.redirect('/sosbuddy/index.html');
});

app.listen(PORT, () => {
  console.log(`SOS Buddy frontend running on port ${PORT}`);
});