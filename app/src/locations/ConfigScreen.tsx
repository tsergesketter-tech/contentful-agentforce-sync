import { useCallback, useEffect, useState } from 'react';
import { ConfigAppSDK } from '@contentful/app-sdk';
import { useSDK } from '@contentful/react-apps-toolkit';
import { Box, Flex, Form, FormControl, Heading, Note, Paragraph, TextInput } from '@contentful/f36-components';

// Read by ../../functions/lib/sfAuth.ts (readSfParams); keep the ids in lockstep with it.
export interface AppInstallationParameters {
  SF_INSTANCE_URL?: string;
  SF_CLIENT_ID?: string;
  SF_CLIENT_SECRET?: string;
  D360_INGEST_SOURCE_NAME?: string;
  D360_DATASPACE?: string;
}

const DEFAULTS: AppInstallationParameters = { D360_INGEST_SOURCE_NAME: 'Contentful', D360_DATASPACE: 'default' };
const SECRET_HELP = "Secret — can't be displayed once saved. Leave blank to keep the saved value.";

const ConfigScreen = () => {
  const [parameters, setParameters] = useState<AppInstallationParameters>(DEFAULTS);
  const sdk = useSDK<ConfigAppSDK>();

  const onConfigure = useCallback(async () => {
    const currentState = await sdk.app.getCurrentState();
    // Secret params never come back from getParameters(); drop blanks so untouched secrets survive.
    const toSubmit = Object.fromEntries(Object.entries(parameters).filter(([, v]) => v !== '' && v !== undefined));
    return { parameters: toSubmit, targetState: currentState };
  }, [parameters, sdk]);

  useEffect(() => {
    sdk.app.onConfigure(() => onConfigure());
  }, [sdk, onConfigure]);

  useEffect(() => {
    (async () => {
      const current = await sdk.app.getParameters<AppInstallationParameters>();
      if (current) setParameters({ ...DEFAULTS, ...current });
      sdk.app.setReady();
    })();
  }, [sdk]);

  const set = (id: keyof AppInstallationParameters) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setParameters((p) => ({ ...p, [id]: e.target.value }));

  return (
    <Box padding="spacingXl" style={{ maxWidth: 640, margin: '0 auto' }}>
      <Heading>Agentforce &amp; Knowledge Sync — Configuration</Heading>
      <Paragraph>
        Salesforce connection used when a linked content type is published, unpublished or deleted: content goes to Data 360 (a search index
        and retriever that ground Agentforce) and/or Salesforce Knowledge (articles for service reps).
      </Paragraph>
      <Form>
        <Heading as="h3">Salesforce org</Heading>
        <FormControl isRequired>
          <FormControl.Label>Salesforce instance URL</FormControl.Label>
          <TextInput value={parameters.SF_INSTANCE_URL ?? ''} onChange={set('SF_INSTANCE_URL')} placeholder="https://YOUR_DOMAIN.my.salesforce.com" />
          <FormControl.HelpText>My Domain URL. Its host and the Data 360 tenant host must be in the manifest's allowNetworks.</FormControl.HelpText>
        </FormControl>
        <FormControl isRequired>
          <FormControl.Label>External Client App client ID</FormControl.Label>
          <TextInput type="password" value={parameters.SF_CLIENT_ID ?? ''} onChange={set('SF_CLIENT_ID')} />
          <FormControl.HelpText>{SECRET_HELP}</FormControl.HelpText>
        </FormControl>
        <FormControl isRequired>
          <FormControl.Label>External Client App client secret</FormControl.Label>
          <TextInput type="password" value={parameters.SF_CLIENT_SECRET ?? ''} onChange={set('SF_CLIENT_SECRET')} />
          <FormControl.HelpText>
            {SECRET_HELP} Client-credentials flow with Data 360 scopes; the run-as user needs Knowledge User and the Contentful_Knowledge_Sync
            permission set.
          </FormControl.HelpText>
        </FormControl>
        <Heading as="h3">Data 360</Heading>
        <FormControl isRequired>
          <FormControl.Label>Ingestion API connector name</FormControl.Label>
          <TextInput value={parameters.D360_INGEST_SOURCE_NAME ?? ''} onChange={set('D360_INGEST_SOURCE_NAME')} />
          <FormControl.HelpText>Connector label; Provision creates it if missing.</FormControl.HelpText>
        </FormControl>
        <FormControl>
          <FormControl.Label>Data space</FormControl.Label>
          <TextInput value={parameters.D360_DATASPACE ?? ''} onChange={set('D360_DATASPACE')} />
        </FormControl>
      </Form>
      <Flex marginTop="spacingM">
        <Note variant="primary">Save with the button in the top bar.</Note>
      </Flex>
    </Box>
  );
};

export default ConfigScreen;
