FROM jenkins/jenkins:2.364-jdk17
ENV JAVA_OPTS -Djenkins.install.runSetupWizard=false
ENV CASC_JENKINS_CONFIG /var/jenkins_home/casc.yaml
USER root
COPY install-docker-on-debian.sh /var/install-docker-on-debian.sh
RUN sh /var/install-docker-on-debian.sh
USER jenkins
COPY --chown=jenkins:jenkins jenkins-plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli -f /usr/share/jenkins/ref/plugins.txt
RUN echo 2.0 > /usr/share/jenkins/ref/jenkins.install.UpgradeWizard.state
COPY --chown=jenkins:jenkins casc.yaml $CASC_JENKINS_CONFIG