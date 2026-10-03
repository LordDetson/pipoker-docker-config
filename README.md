# pipoker-docker-config

Scripts that start the PiPoker infrastructure on one Docker host. All containers join the `pipokernet` network.

| Container  | Build            | Run                                                                                                          |
|------------|------------------|--------------------------------------------------------------------------------------------------------------|
| `rebbitmq` | `build-rebbitmq` | `run-rebbitmq <username> <password>`                                                                         |
| `mongodb`  | `build-mongodb`  | `run-mongodb <root username> <root password> <app username> <app password>`                                  |
| `jenkins`  | `build-jenkins`  | `run-jenkins <github token> <jenkins login> <jenkins password> <docker hub username> <docker hub password> <server ip> <broker username> <broker password> <mongodb app username> <mongodb app password>` |

The broker and MongoDB application credentials passed to `run-jenkins` must match the ones passed to `run-rebbitmq` and `run-mongodb`.
Jenkins stores them as the `BrokerLogin` and `MongoDbLogin` credentials, and the pipoker-app pipeline passes them to the `pipoker-api` container.

MongoDB keeps its data in the `pipoker-mongodb-data` volume. The application user is created in the `pipoker` database only on the first start with an empty volume.
