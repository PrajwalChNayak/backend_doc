export const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/nest_mongoose_example'

export const DOCKER_HINT = [
  '',
  '  nest-mongoose needs a MongoDB server and could not reach one at:',
  `    ${MONGODB_URI}`,
  '',
  '  Start one with Docker:',
  '',
  '    docker run --rm -p 27017:27017 mongo:8',
  '',
  '  …then run `npm start` again. Override the target with MONGODB_URI.',
  '',
].join('\n')
