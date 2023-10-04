/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EuiPanel,
  EuiTitle,
  EuiSpacer,
  EuiText,
  EuiLink,
  EuiFormRow,
  EuiFieldText,
  EuiTextArea,
  EuiSelect,
} from '@elastic/eui';
import React, { useState } from 'react';
import {
  AuthMethod,
  OPENSEARCH_DOCUMENTATION_URL,
} from '../../../../../common/constants/data_connections';
import { QueryPermissionsConfiguration } from './query_permissions';
import { Role } from '../../../../../common/types/data_connections';
import { AuthDetails } from './auth_details';

interface ConfigureS3DatasourceProps {
  roles: Role[];
  selectedQueryPermissionRoles: Role[];
  setSelectedQueryPermissionRoles: React.Dispatch<React.SetStateAction<Role[]>>;
  currentName: string;
  currentDetails: string;
  currentArn: string;
  currentStore: string;
  currentAuthMethod: AuthMethod;
  currentUsername: string;
  currentPassword: string;
  setAuthMethodForRequest: React.Dispatch<React.SetStateAction<AuthMethod>>;
  setPasswordForRequest: React.Dispatch<React.SetStateAction<string>>;
  setUsernameForRequest: React.Dispatch<React.SetStateAction<string>>;
  setStoreForRequest: React.Dispatch<React.SetStateAction<string>>;
  setNameForRequest: React.Dispatch<React.SetStateAction<string>>;
  setDetailsForRequest: React.Dispatch<React.SetStateAction<string>>;
  setArnForRequest: React.Dispatch<React.SetStateAction<string>>;
}

export const ConfigureS3Datasource = (props: ConfigureS3DatasourceProps) => {
  const {
    setNameForRequest,
    setDetailsForRequest,
    setArnForRequest,
    setStoreForRequest,
    currentStore,
    currentName,
    currentDetails,
    currentArn,
    roles,
    currentAuthMethod,
    setAuthMethodForRequest,
    selectedQueryPermissionRoles,
    setSelectedQueryPermissionRoles,
    currentPassword,
    currentUsername,
    setPasswordForRequest,
    setUsernameForRequest,
  } = props;

  const [name, setName] = useState(currentName);
  const [details, setDetails] = useState(currentDetails);
  const [arn, setArn] = useState(currentArn);
  const [store, setStore] = useState(currentStore);
  const authOptions = [
    { value: 'basicauth', text: 'Basic authentication' },
    { value: 'noauth', text: 'No authentication' },
  ];

  return (
    <div>
      <EuiPanel>
        <EuiTitle>
          <h1>{`Configure S3 Data Source`}</h1>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiText size="s" color="subdued">
          {`Connect to S3with OpenSearch and OpenSearch Dashboards `}
          <EuiLink external={true} href={OPENSEARCH_DOCUMENTATION_URL} target="blank">
            Learn more
          </EuiLink>
        </EuiText>
        <EuiSpacer />
        <EuiText>
          <h3>Data source details</h3>
        </EuiText>
        <EuiSpacer />
        <EuiFormRow label="Data source name">
          <>
            <EuiText size="xs">
              <p>
                This is the name the connection will be referenced by in OpenSearch Dashboards. It
                is recommended to make this short yet descriptive to help users when selecting a
                connection.
              </p>
            </EuiText>
            <EuiFieldText
              data-test-subj="data-source-name"
              placeholder="Title"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              onBlur={(e) => {
                setNameForRequest(e.target.value);
              }}
            />
          </>
        </EuiFormRow>
        <EuiFormRow label="Description - Optional">
          <EuiTextArea
            placeholder="Placeholder"
            value={details}
            onBlur={(e) => {
              setDetailsForRequest(e.target.value);
            }}
            onChange={(e) => {
              setDetails(e.target.value);
            }}
          />
        </EuiFormRow>
        <EuiSpacer />

        <EuiText>
          <h3>Glue authentication details</h3>
        </EuiText>
        <EuiSpacer />

        <EuiFormRow label="Authentication Method">
          <>
            <EuiText size="xs">
              <p>
                This parameters provides the authentication type information required for execution
                engine to connect to glue.
              </p>
            </EuiText>
            <EuiFieldText data-test-subj="authentication-method" value="IAM role" disabled />
          </>
        </EuiFormRow>

        <EuiFormRow label="Glue authenticaiton ARN">
          <>
            <EuiText size="xs">
              <p>This should be the IAM role ARN</p>
            </EuiText>
            <EuiFieldText
              data-test-subj="role-ARN"
              placeholder="Role ARN"
              value={arn}
              onChange={(e) => {
                setArn(e.target.value);
              }}
              onBlur={(e) => {
                setArnForRequest(e.target.value);
              }}
            />
          </>
        </EuiFormRow>

        <EuiSpacer />

        <EuiText>
          <h3>Glue index store details</h3>
        </EuiText>
        <EuiSpacer />

        <EuiFormRow label="Glue index store URI">
          <>
            <EuiText size="xs">
              <p>
                This parameters provides the OpenSearch cluster host information for glue. This
                OpenSearch instance is used for writing index data back.
              </p>
            </EuiText>
            <EuiFieldText
              data-test-subj="index-URI"
              placeholder="Index store URI"
              value={store}
              onChange={(e) => {
                setStore(e.target.value);
              }}
              onBlur={(e) => {
                setStoreForRequest(e.target.value);
              }}
            />
          </>
        </EuiFormRow>

        <EuiFormRow label="Glue index store authentication">
          <>
            <EuiText size="xs">
              <p>Authentication settings to access the index store.</p>
            </EuiText>
            <EuiSelect
              id="selectAuthMethod"
              options={authOptions}
              value={currentAuthMethod}
              onChange={(e) => {
                setAuthMethodForRequest(e.target.value as AuthMethod);
              }}
            />
          </>
        </EuiFormRow>
        <AuthDetails
          currentUsername={currentUsername}
          setUsernameForRequest={setUsernameForRequest}
          currentPassword={currentPassword}
          setPasswordForRequest={setPasswordForRequest}
          currentAuthMethod={currentAuthMethod}
        />

        <EuiSpacer />

        <QueryPermissionsConfiguration
          roles={roles}
          selectedRoles={selectedQueryPermissionRoles}
          setSelectedRoles={setSelectedQueryPermissionRoles}
          layout={'vertical'}
        />
      </EuiPanel>
    </div>
  );
};