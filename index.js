const fsp = require('fs').promises
const HyperspaceClient = require('hyperspace/client')
const HyperspaceServer = require('hyperspace/server')
const hyperdrive = require('hyperdrive')
const got = require('got')

main()
async function main () {
  var hserver
  var hclient
  const cleanup = async () => {
    if (hclient) await hclient.close()
    if (hserver) await hserver.close()
  }
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)

  console.log('Initializing hyperspace server')
  hserver = new HyperspaceServer({
    host: 'beaker-index-hyperspace',
    storage: './.data'
  })
  await hserver.ready()

  console.log('Initializing hyperspace client')
  hclient = new HyperspaceClient({ host: 'beaker-index-hyperspace' })
  await hclient.ready()

  const indexDriveUrl = await fsp.readFile('./.index-drive-url', 'utf8').catch(e => undefined)
  console.log(indexDriveUrl ? 'Loading' : 'Creating new', 'index drive', indexDriveUrl)
  const indexDrive = hyperdrive(hclient.corestore, indexDriveUrl ? urlToKey(indexDriveUrl) : null, {extension: false})
  await indexDrive.promises.ready()
  await fsp.writeFile('./.index-drive-url', `hyper://${indexDrive.key.toString('hex')}`, 'utf8')
  await hclient.network.configure(indexDrive.discoveryKey, { announce: true, flush: true })
  console.log('Index drive: hyper://' + indexDrive.key.toString('hex'))
  await ensureIndexDriveManifest(indexDrive)

  while (true) {
    console.log('Indexer tick', (new Date()).toLocaleString())
    try {
      let users = await getUsersList()
      console.log(users.length, 'users')      

      let newDb = {
        sources: users,
        links: {}
      }

      for (let user of users) {
        let userDrive
        try {
          console.log('Indexing', user)
          userDrive = await loadDrive(hclient, user.url)
          
          let userManifest = await readManifest(userDrive)
          if (userManifest) {
            if (user.title && typeof user.title === 'string' && user.title !== userManifest.title) user.title = userManifest.title
            if (user.description && typeof user.description === 'string' && user.description !== userManifest.description) user.description = userManifest.description
          }

          await readLinkGotos(newDb, user, userDrive)
        } catch (e) {
          console.log('Failed to index user', e)
        } finally {
          if (userDrive) await userDrive.promises.close()
        }
      }

      let currentDb = await readDb(indexDrive)
      console.log(currentDb, newDb)
      if (!deepEqual(currentDb, newDb)) {
        console.log('Writing new database')
        await writeDb(indexDrive, newDb)
      }
      
    } catch (e) {
      console.log('Error during tick', e)
    }
    await new Promise(r => setTimeout(r, 60e3))
  }
}

async function ensureIndexDriveManifest (indexDrive) {
  const indexDriveManifest = JSON.stringify({
    title: 'Beaker Index',
    description: 'An index generated from Beaker\'s userlist'
  }, null, 2)
  const currentManifest = await indexDrive.promises.readFile('/index.json', 'utf8').catch(e => '')
  if (currentManifest !== indexDriveManifest) {
    await indexDrive.promises.writeFile('/index.json', indexDriveManifest, 'utf8')
  }
}

async function getUsersList () {
  try {
    var res = await got('https://userlist.beakerbrowser.com/list.json', {responseType: 'json'})
  } catch (e) {
    console.error(e)
    throw new Error('Failed to fetch users')
  }
  return res.body.users.map(user => ({
    url: user.driveUrl,
    title: user.title,
    description: user.description
  }))
}

async function readDb (indexDrive) {
  try {
    const str = await indexDrive.promises.readFile('/db.json', 'utf8').catch(e => '')
    const obj = JSON.parse(str)
    if (!obj.sources || !Array.isArray(obj.sources)) throw "invalid"
    if (obj.links || typeof obj.links !== 'object') throw "invalid"
  } catch (e) {
    return {sources: [], links: {}}
  }
}

async function writeDb (indexDrive, db) {
  await indexDrive.promises.writeFile('/db.json', JSON.stringify(db, null, 2), 'utf8')
}

async function loadDrive (hclient, url) {  
  console.log('Loading user drive:', url)
  const key = urlToKey(url)
  const userDrive = hyperdrive(hclient.corestore, key, {extension: false})
  await userDrive.promises.ready()
  await hclient.network.configure(userDrive.discoveryKey, { announce: false, lookup: true, flush: true })

  return userDrive
}

async function readManifest (userDrive) {
  return timeout(10e3, undefined, async () => {
    const str = await userDrive.promises.readFile('/index.json', 'utf8').catch(e => undefined)
    try {
      return JSON.parse(str)
    } catch (e) {
      return undefined
    }
  })
}

async function readLinkGotos (db, user, userDrive) {
  let linksFolders = await timeout(10e3, [], () => userDrive.promises.readdir('/links').catch(e => ([])))
  for (let folder of linksFolders) {
    let gotos = await timeout(10e3, [], () => userDrive.promises.readdir(`/links/${folder}`, {includeStats: true}).catch(e => ([])))
    for (let goto of gotos.filter(item => item.name.endsWith('.goto'))) {
      if (!goto.stat.metadata.href) continue
      db.links[folder] = db.links[folder] || []
      db.links[folder].push({
        sourceIndex: db.sources.indexOf(user),
        title: goto.stat.metadata.title || goto.name,
        description: goto.stat.metadata.description,
        href: normalizeUrl(goto.stat.metadata.href)
      })
    }
  }
}

async function timeout (n, timeoutValue, fn) {
  return Promise.race([
    fn(),
    new Promise((resolve, reject) => {
      setTimeout(() => { resolve(timeoutValue) }, n)
    })
  ])
}

function urlToKey (url) {
  return Buffer.from(/([0-9a-f]{64})/i.exec(url)[1], 'hex')
}

function normalizeUrl (url) {
  try {
    let urlp = new URL(url)
    return urlp.toString()
  } catch (e) {
    return url
  }
}

function deepEqual (x, y) {
  if (x === y) {
    return true;
  }
  else if ((typeof x == "object" && x != null) && (typeof y == "object" && y != null)) {
    if (Object.keys(x).length != Object.keys(y).length) {
      console.log('key length differed', x, y)
      return false;
    }

    for (var prop in x) {
      if (y.hasOwnProperty(prop))
      {  
        if (! deepEqual(x[prop], y[prop]))
          return false;
      }
      else {
        console.log('propery mismatch', prop, x, y)
        return false;
      }
    }

    return true;
  }
  else {
    console.log('not equal', x, y)
    return false;
  }
}
