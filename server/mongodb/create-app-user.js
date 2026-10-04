// Runs once, on the first start with an empty data volume.
// Creates the user the application connects with, restricted to the application database.
const appDb = process.env.MONGO_INITDB_DATABASE;
db.getSiblingDB(appDb).createUser({
  user: process.env.MONGODB_APP_USERNAME,
  pwd: process.env.MONGODB_APP_PASSWORD,
  roles: [{ role: "readWrite", db: appDb }]
});
